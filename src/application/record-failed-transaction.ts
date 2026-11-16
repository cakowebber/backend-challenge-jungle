import { WagerTransactionFailed } from '../domain/events/wager-events';
import { InfrastructureFailureCode } from '../domain/failure-code';
import { InboxMessage } from '../domain/inbox-message';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { wagerPayloadHash } from './payload-hash';
import type { Clock } from './ports/clock';
import type { IdGenerator } from './ports/id-generator';
import { MetricName, type Metrics } from './ports/observability';
import type {
  InboxRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from './ports/repositories';
import type { UnitOfWork } from './ports/unit-of-work';
import { messagePayloadHash, type ProcessWagerTransactionCommand } from './process-wager-transaction';

export type RecordFailedOutcome =
  /** A transação foi gravada como FAILED. */
  | 'RECORDED'
  /** Já existia um registro para esta operação ou mensagem; nada foi alterado. */
  | 'ALREADY_SETTLED'
  /** Não há como gravar (a wallet não existe). */
  | 'NOT_RECORDABLE';

/**
 * Último recurso: uma operação que esgotou as tentativas por erro permanente
 * (não de negócio, não transitório) é gravada como FAILED, para ficar auditável
 * em vez de só desaparecer numa DLQ.
 *
 * FAILED é terminal: o id fica "queimado". Reenviar a mesma mensagem devolve o
 * FAILED como replay; para tentar de novo o provedor usa um novo id.
 * Não move saldo, não gera ledger e não precisa do lock da wallet.
 */
export class RecordFailedTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly inbox: InboxRepository,
    private readonly outbox: OutboxRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<RecordFailedOutcome> {
    const now = this.clock.now();
    const payloadHash = wagerPayloadHash({ ...command, money: command.money.toJSON() });

    const outcome = await this.unitOfWork.transactional(async (): Promise<RecordFailedOutcome> => {
      if (command.inbox !== undefined) {
        const message = InboxMessage.receive({
          messageId: command.inbox.messageId,
          consumerName: command.inbox.consumerName,
          payloadHash: messagePayloadHash(command, payloadHash),
          receivedAt: now,
        });
        message.markProcessed(now);
        if (!(await this.inbox.insertIfAbsent(message))) {
          return 'ALREADY_SETTLED';
        }
      }

      if ((await this.wallets.findById(command.walletId)) === undefined) {
        return 'NOT_RECORDABLE';
      }

      const transaction = WagerTransaction.create({
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
      transaction.fail(InfrastructureFailureCode.ProcessingFailed);

      if (!(await this.transactions.insertIfAbsent(transaction))) {
        return 'ALREADY_SETTLED';
      }
      await this.outbox.add([
        OutboxMessage.enqueue(
          WagerTransactionFailed.from(transaction, {
            eventId: this.ids.next(),
            correlationId: command.correlationId,
            causationId: command.causationId,
            occurredAt: now,
          }),
        ),
      ]);
      return 'RECORDED';
    });

    if (outcome === 'RECORDED') {
      this.metrics.increment(MetricName.TransactionsByStatus, { status: 'FAILED' });
    }
    return outcome;
  }
}
