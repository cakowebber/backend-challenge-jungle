import { WagerTransactionStatus } from '../domain/wager-transaction';
import type { ApplyWagerTransaction } from './apply-wager-transaction';
import { TransientFailureError } from './errors';
import type { Clock } from './ports/clock';
import type { IdGenerator } from './ports/id-generator';
import { MetricName, type AppLogger, type Metrics } from './ports/observability';
import type { PendingReferenceCandidate, WagerTransactionRepository, WalletRepository } from './ports/repositories';
import type { UnitOfWork } from './ports/unit-of-work';

export type ReferenceRetryOutcome =
  /** A referência chegou e a transação foi aplicada (PROCESSED). */
  | 'RESOLVED'
  /** Rejeitada: a referência chegou inválida, ou as tentativas esgotaram (REFERENCE_NOT_FOUND). */
  | 'REJECTED'
  /** A referência ainda não chegou: tentativa contada e próxima agendada com backoff. */
  | 'RESCHEDULED'
  /** Outra instância já tratou esta transação; nada a fazer. */
  | 'SKIPPED'
  /** Não deu para tentar agora (lock ocupado, erro); continua vencida para o próximo ciclo. */
  | 'ERRORED';

export interface RetryPendingReferencesResult {
  /** Candidatas encontradas neste ciclo. */
  found: number;
  outcomes: Readonly<Record<ReferenceRetryOutcome, number>>;
}

/**
 * Um ciclo do worker de PENDING_REFERENCE: reprocessa REFUND/ROLLBACK que
 * chegaram antes da transação que referenciam.
 *
 * Cada transação é tratada na SUA transação SQL, com o mesmo roteiro da entrada:
 *
 *   1. SELECT ... FOR UPDATE na wallet (a mesma ordem de locks de todo o sistema);
 *   2. relê a transação — outra instância pode tê-la resolvido enquanto
 *      esperávamos o lock; se não está mais pendente e vencida, pula;
 *   3. ApplyWagerTransaction: o MESMO código da entrada resolve a referência,
 *      aplica as regras, grava saldo, ledger, desfecho e eventos na outbox.
 *
 * Com várias instâncias, duas podem pegar a mesma candidata: o lock da wallet
 * as coloca em fila e a releitura do passo 2 faz a segunda desistir. A lista
 * de candidatas é lida sem lock justamente por isso — ela é só uma dica.
 */
export class RetryPendingReferences {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly applier: ApplyWagerTransaction,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(limit: number): Promise<RetryPendingReferencesResult> {
    const candidates = await this.unitOfWork.session(() =>
      this.transactions.findDuePendingReferences(this.clock.now(), limit),
    );

    const outcomes: Record<ReferenceRetryOutcome, number> = {
      RESOLVED: 0,
      REJECTED: 0,
      RESCHEDULED: 0,
      SKIPPED: 0,
      ERRORED: 0,
    };
    for (const candidate of candidates) {
      // Só depois do commit de cada uma é que o desfecho é contado.
      const outcome = await this.retryGuarded(candidate);
      outcomes[outcome] += 1;
      this.metrics.increment(MetricName.ReferenceRetries, { outcome });
      if (outcome === 'RESOLVED') {
        this.metrics.increment(MetricName.TransactionsByStatus, { status: WagerTransactionStatus.Processed });
      } else if (outcome === 'REJECTED') {
        this.metrics.increment(MetricName.TransactionsByStatus, { status: WagerTransactionStatus.Rejected });
      }
    }
    return { found: candidates.length, outcomes };
  }

  /** Uma candidata com problema não impede as outras do ciclo. */
  private async retryGuarded(candidate: PendingReferenceCandidate): Promise<ReferenceRetryOutcome> {
    try {
      return await this.retry(candidate);
    } catch (error) {
      // Nada foi commitado: a transação continua pendente e vencida, e o
      // próximo ciclo (desta ou de outra instância) tenta de novo.
      const fields = {
        transactionId: candidate.transactionId,
        walletId: candidate.walletId,
        reason: error instanceof Error ? error.message : String(error),
      };
      if (error instanceof TransientFailureError) {
        this.logger.warn('pending-reference: tentativa adiada por falha transitória', fields);
      } else {
        this.logger.error('pending-reference: erro inesperado ao reprocessar', fields);
      }
      return 'ERRORED';
    }
  }

  private retry(candidate: PendingReferenceCandidate): Promise<ReferenceRetryOutcome> {
    return this.unitOfWork.transactional(async (): Promise<ReferenceRetryOutcome> => {
      const wallet = await this.wallets.lockById(candidate.walletId);
      const transaction = await this.transactions.findById(candidate.transactionId);
      const now = this.clock.now();

      if (
        wallet === undefined ||
        transaction === undefined ||
        transaction.status !== WagerTransactionStatus.PendingReference ||
        transaction.nextReferenceAttemptAt === undefined ||
        transaction.nextReferenceAttemptAt > now
      ) {
        return 'SKIPPED';
      }

      // A requisição original já terminou (e o correlationId dela não é
      // guardado na transação): cada resolução abre uma correlação nova, e a
      // causa dos eventos é a própria transação pendente. O rastreio de ponta
      // a ponta é pelo transactionId, presente em todos os eventos.
      await this.applier.apply(wallet, transaction, {
        correlationId: this.ids.next(),
        causationId: transaction.id,
        now,
      });

      // `apply` mudou o estado da transação; o compilador ainda a vê como
      // PENDING_REFERENCE por causa da checagem acima, daí a anotação.
      const statusAfter = transaction.status as WagerTransactionStatus;
      switch (statusAfter) {
        case WagerTransactionStatus.Processed:
          return 'RESOLVED';
        case WagerTransactionStatus.Rejected:
          return 'REJECTED';
        default:
          return 'RESCHEDULED';
      }
    });
  }
}
