import { DomainInvariantError } from '../domain/errors';
import { InboxMessage } from '../domain/inbox-message';
import type { Money } from '../domain/money';
import { WagerTransaction, type WagerTransactionKind } from '../domain/wager-transaction';
import type { ApplyWagerTransaction } from './apply-wager-transaction';
import {
  ApplicationError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  MessageIdConflictError,
  WalletNotFoundForTransactionError,
} from './errors';
import { canonicalJson, sha256Hex, wagerPayloadHash } from './payload-hash';
import type { Clock } from './ports/clock';
import type { IdGenerator } from './ports/id-generator';
import { MetricName, type AppLogger, type Metrics } from './ports/observability';
import type { InboxRepository, WagerTransactionRepository, WalletRepository } from './ports/repositories';
import type { UnitOfWork } from './ports/unit-of-work';

/** Identidade da mensagem na inbox, quando o comando veio da fila. */
export interface InboxReference {
  consumerName: string;
  messageId: string;
}

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  /** Rastreio: acompanha a requisição até os eventos. */
  correlationId: string;
  /** O que causou este comando (ex.: messageId da fila). */
  causationId: string | undefined;
  /** Presente só na entrada pela fila: a mensagem é registrada na mesma transação SQL. */
  inbox: InboxReference | undefined;
}

export interface ProcessWagerTransactionResult {
  transaction: WagerTransaction;
  /** true quando a transação já existia e o resultado gravado foi devolvido. */
  idempotentReplay: boolean;
}

/** Hash do conteúdo da mensagem, para distinguir redelivery de reuso do messageId. */
export function messagePayloadHash(command: ProcessWagerTransactionCommand, payloadHash: string): string {
  return sha256Hex(canonicalJson({ idempotencyKey: command.idempotencyKey, payloadHash }));
}

/**
 * Use case único para HTTP e fila. Fluxo:
 *
 *   HTTP: 1. sem lock, busca pela idempotency key. Achou -> replay (ou conflito).
 *         2. BEGIN
 *   Fila: 1. BEGIN e INSERT na inbox (consumer, messageId). Conflito -> mensagem
 *            já processada: devolve o resultado gravado.
 *         2. busca pela idempotency key, já dentro da transação.
 *   Ambos:
 *         3. trava a wallet (SELECT ... FOR UPDATE). Não existe -> rejeição sem registro.
 *         4. INSERT da transação com ON CONFLICT DO NOTHING. Não inseriu -> outra
 *            requisição com a mesma chave venceu: devolve o resultado dela.
 *       5-7. referência, regras, saldo + ledger + desfecho + outbox (ApplyWagerTransaction).
 *         8. COMMIT. Só depois quem chamou responde ao HTTP ou dá ack na fila.
 *
 * Inbox, saldo, ledger, transação e outbox são gravados na MESMA transação SQL:
 * ou a mensagem está registrada e o efeito aplicado, ou nenhum dos dois.
 *
 * A wallet é travada ANTES do INSERT porque o INSERT tem FK para a wallet e a
 * checagem da FK pega um lock compartilhado nela: inserir primeiro e travar
 * depois faz duas requisições da mesma wallet entrarem em deadlock.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly inbox: InboxRepository,
    private readonly applier: ApplyWagerTransaction,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Mede e registra o processamento. É o único ponto por onde passam as duas
   * entradas, então log e latência saem iguais para HTTP e fila.
   *
   * O log leva só identificadores e o desfecho. Valor, saldo e o payload não
   * entram. Falhas são logadas por quem decide o que fazer com elas: o filtro
   * HTTP (status) ou o handler da fila (retry ou DLQ).
   */
  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const startedAt = performance.now();
    const source = command.inbox === undefined ? 'http' : 'sqs';
    const elapsedSeconds = () => (performance.now() - startedAt) / 1000;

    let result: ProcessWagerTransactionResult;
    try {
      result = await this.process(command);
    } catch (error) {
      this.metrics.observe(MetricName.TransactionDuration, elapsedSeconds(), {
        source,
        outcome: error instanceof ApplicationError ? error.code : 'ERROR',
      });
      throw error;
    }

    const seconds = elapsedSeconds();
    const { transaction, idempotentReplay } = result;
    this.metrics.observe(MetricName.TransactionDuration, seconds, {
      source,
      outcome: idempotentReplay ? 'DUPLICATE' : transaction.status,
    });
    this.logger.info(idempotentReplay ? 'transação repetida: resultado original devolvido' : 'transação processada', {
      correlationId: command.correlationId,
      messageId: command.inbox?.messageId,
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      kind: transaction.kind,
      status: transaction.status,
      failureCode: transaction.failureCode,
      idempotentReplay,
      source,
      durationMs: Math.round(seconds * 1000),
    });
    return result;
  }

  private async process(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const now = this.clock.now();
    const payloadHash = wagerPayloadHash({ ...command, money: command.money.toJSON() });

    // Valida as regras de formato da operação (kind, referência, valor) antes de
    // tocar no banco. Erro aqui é payload inválido, não rejeição de negócio.
    const candidate = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    if (command.inbox === undefined) {
      // HTTP, passo 1. Atalho sem lock: a maioria dos reenvios termina aqui.
      const known = await this.unitOfWork.session(() =>
        this.transactions.findByIdempotencyKey(command.idempotencyKey),
      );
      if (known !== undefined) {
        return this.replay(known, payloadHash);
      }
    }

    const result = await this.unitOfWork.transactional(async () => {
      if (command.inbox !== undefined) {
        // Fila, passos 1 e 2.
        const settled = await this.registerMessage(command, command.inbox, payloadHash, now);
        if (settled !== undefined) {
          return settled;
        }
      }

      // 3. Lock da wallet. A partir daqui, e até o COMMIT, nenhuma outra
      //    transação lê ou altera o saldo desta wallet.
      const wallet = await this.wallets.lockById(command.walletId);
      if (wallet === undefined) {
        throw new WalletNotFoundForTransactionError(command.walletId);
      }

      // 4. A unicidade é decidida pelo banco, nunca por "consultei e não achei".
      const inserted = await this.transactions.insertIfAbsent(candidate);
      if (!inserted) {
        return this.replay(await this.findWinner(command), payloadHash);
      }

      // 5 a 7.
      await this.applier.apply(wallet, candidate, {
        correlationId: command.correlationId,
        causationId: command.causationId,
        now,
      });
      return { transaction: candidate, idempotentReplay: false };
    });

    if (!result.idempotentReplay) {
      this.metrics.increment(MetricName.TransactionsByStatus, { status: result.transaction.status });
    }
    return result;
  }

  /**
   * Registra a mensagem na inbox. Devolve o resultado já gravado quando a
   * mensagem (ou a operação) já foi resolvida; undefined quando é trabalho novo.
   * O registro só sobrevive se a transação inteira commitar.
   */
  private async registerMessage(
    command: ProcessWagerTransactionCommand,
    reference: InboxReference,
    payloadHash: string,
    now: Date,
  ): Promise<ProcessWagerTransactionResult | undefined> {
    const message = InboxMessage.receive({
      messageId: reference.messageId,
      consumerName: reference.consumerName,
      payloadHash: messagePayloadHash(command, payloadHash),
      receivedAt: now,
    });
    message.markProcessed(now);

    // A deduplicação é do banco: PK (consumer_name, message_id).
    const firstDelivery = await this.inbox.insertIfAbsent(message);
    if (!firstDelivery) {
      const recorded = await this.inbox.find(reference.consumerName, reference.messageId);
      if (recorded !== undefined && recorded.payloadHash !== message.payloadHash) {
        throw new MessageIdConflictError(reference.messageId);
      }
      // Redelivery: o efeito já foi commitado junto com o registro da inbox.
      const settled = await this.transactions.findByIdempotencyKey(command.idempotencyKey);
      if (settled === undefined) {
        throw new DomainInvariantError(
          `mensagem ${reference.messageId} consta na inbox, mas a transação dela não existe`,
        );
      }
      return this.replay(settled, payloadHash);
    }

    // Mensagem nova, mas a operação pode já ter chegado por HTTP ou em outra mensagem.
    const known = await this.transactions.findByIdempotencyKey(command.idempotencyKey);
    return known === undefined ? undefined : this.replay(known, payloadHash);
  }

  /** A transação já existe: mesmo payload devolve o resultado gravado; payload diferente é conflito. */
  private replay(existing: WagerTransaction, payloadHash: string): ProcessWagerTransactionResult {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(existing.idempotencyKey);
    }
    this.metrics.increment(MetricName.DuplicatesDetected);
    return { transaction: existing, idempotentReplay: true };
  }

  /**
   * O INSERT foi recusado por unicidade. Se foi pela idempotency key, a
   * vencedora é encontrada por ela. Se não, o conflito foi em
   * (provider, id externo): a mesma operação chegou com outra chave.
   */
  private async findWinner(command: ProcessWagerTransactionCommand): Promise<WagerTransaction> {
    const winner = await this.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (winner === undefined) {
      throw new ExternalTransactionConflictError(command.providerId, command.externalTransactionId);
    }
    return winner;
  }
}
