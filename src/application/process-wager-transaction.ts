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
  correlationId: string;
  causationId: string | undefined;
  inbox: InboxReference | undefined;
}

export interface ProcessWagerTransactionResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

export function messagePayloadHash(command: ProcessWagerTransactionCommand, payloadHash: string): string {
  return sha256Hex(canonicalJson({ idempotencyKey: command.idempotencyKey, payloadHash }));
}

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
      const known = await this.unitOfWork.session(() =>
        this.transactions.findByIdempotencyKey(command.idempotencyKey),
      );
      if (known !== undefined) {
        return this.replay(known, payloadHash);
      }
    }

    const result = await this.unitOfWork.transactional(async () => {
      if (command.inbox !== undefined) {
        const settled = await this.registerMessage(command, command.inbox, payloadHash, now);
        if (settled !== undefined) {
          return settled;
        }
      }

      const wallet = await this.wallets.lockById(command.walletId);
      if (wallet === undefined) {
        throw new WalletNotFoundForTransactionError(command.walletId);
      }

      const inserted = await this.transactions.insertIfAbsent(candidate);
      if (!inserted) {
        return this.replay(await this.findWinner(command), payloadHash);
      }

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

    const firstDelivery = await this.inbox.insertIfAbsent(message);
    if (!firstDelivery) {
      const recorded = await this.inbox.find(reference.consumerName, reference.messageId);
      if (recorded !== undefined && recorded.payloadHash !== message.payloadHash) {
        throw new MessageIdConflictError(reference.messageId);
      }
      const settled = await this.transactions.findByIdempotencyKey(command.idempotencyKey);
      if (settled === undefined) {
        throw new DomainInvariantError(
          `mensagem ${reference.messageId} consta na inbox, mas a transação dela não existe`,
        );
      }
      return this.replay(settled, payloadHash);
    }

    const known = await this.transactions.findByIdempotencyKey(command.idempotencyKey);
    return known === undefined ? undefined : this.replay(known, payloadHash);
  }

  private replay(existing: WagerTransaction, payloadHash: string): ProcessWagerTransactionResult {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(existing.idempotencyKey);
    }
    this.metrics.increment(MetricName.DuplicatesDetected);
    return { transaction: existing, idempotentReplay: true };
  }

  private async findWinner(command: ProcessWagerTransactionCommand): Promise<WagerTransaction> {
    const winner = await this.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (winner === undefined) {
      throw new ExternalTransactionConflictError(command.providerId, command.externalTransactionId);
    }
    return winner;
  }
}
