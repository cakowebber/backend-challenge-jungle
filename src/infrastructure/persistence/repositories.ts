import { LockMode, type EntityData } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { TransientFailureError } from '../../application/errors';
import { METRICS, MetricName, type Metrics } from '../../application/ports/observability';
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  PendingReferenceCandidate,
  PositionedLedgerEntry,
  WagerTransactionRepository,
  WalletLedgerSnapshot,
  WalletRepository,
} from '../../application/ports/repositories';
import { DomainInvariantError } from '../../domain/errors';
import { Money } from '../../domain/money';
import type { InboxMessage } from '../../domain/inbox-message';
import type { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import {
  inboxMessageFromRecord,
  inboxMessageToRecord,
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
  outboxMessageFromRecord,
  outboxMessageToRecord,
  transactionFromRecord,
  transactionOutcomeToRecord,
  transactionToRecord,
  walletFromRecord,
  walletToRecord,
} from './mappers';
import {
  InboxMessageSchema,
  LedgerEntrySchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletSchema,
  type WagerTransactionRecord,
} from './records';

const FRESH = { disableIdentityMap: true } as const;

@Injectable()
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(
    private readonly em: EntityManager,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async insertIfAbsent(wallet: Wallet): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(WalletSchema)
      .insert(walletToRecord(wallet))
      .onConflict()
      .ignore()
      .execute('run');
    return result.affectedRows === 1;
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, FRESH);
    return record === null ? undefined : walletFromRecord(record);
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const startedAt = performance.now();
    try {
      const record = await this.em.findOne(
        WalletSchema,
        { id },
        { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      return record === null ? undefined : walletFromRecord(record);
    } finally {
      this.metrics.observe(MetricName.WalletLockWait, (performance.now() - startedAt) / 1000);
    }
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.toJSON().amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new TransientFailureError('CONCURRENT_UPDATE');
    }
  }

  async ledgerSnapshot(id: string): Promise<WalletLedgerSnapshot | undefined> {
    const rows = await this.em.execute<
      { balance: string; currency: string; credits: string; debits: string; entries: string }[]
    >(
      `SELECT w.balance,
              w.currency,
              COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'CREDIT'), 0)::numeric(19,2) AS credits,
              COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'DEBIT'), 0)::numeric(19,2)  AS debits,
              COUNT(e.id) AS entries
         FROM wallets w
         LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
        WHERE w.id = ?
        GROUP BY w.id`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      storedBalance: Money.from({ amount: row.balance, currency: row.currency }),
      credits: Money.from({ amount: row.credits, currency: row.currency }),
      debits: Money.from({ amount: row.debits, currency: row.currency }),
      entries: Number(row.entries),
    };
  }
}

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(WagerTransactionSchema)
      .insert(transactionToRecord(transaction))
      .onConflict()
      .ignore()
      .execute('run');
    return result.affectedRows === 1;
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ idempotencyKey });
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async saveOutcome(transaction: WagerTransaction): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id },
      transactionOutcomeToRecord(transaction) as EntityData<WagerTransactionRecord>,
    );
    if (affected !== 1) {
      throw new DomainInvariantError(`transação ${transaction.id} não está gravada para receber o desfecho`);
    }
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]> {
    const records = await this.em.find(
      WagerTransactionSchema,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { ...FRESH, fields: ['id', 'walletId'], orderBy: { nextReferenceAttemptAt: 'asc' }, limit },
    );
    return records.map((record) => ({ transactionId: record.id, walletId: record.walletId }));
  }

  private async findOne(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, where, FRESH);
    return record === null ? undefined : transactionFromRecord(record);
  }
}

@Injectable()
export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.createQueryBuilder(LedgerEntrySchema).insert(ledgerEntryToRecord(entry)).execute('run');
  }

  async listByWallet(
    walletId: string,
    options: { afterPosition: string | undefined; limit: number },
  ): Promise<PositionedLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntrySchema,
      { walletId, ...(options.afterPosition === undefined ? {} : { seq: { $gt: options.afterPosition } }) },
      { ...FRESH, orderBy: { seq: 'asc' }, limit: options.limit },
    );
    return records.map((record) => ({ entry: ledgerEntryFromRecord(record), position: record.seq as string }));
  }
}

@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.em
      .createQueryBuilder(OutboxMessageSchema)
      .insert(messages.map((message) => outboxMessageToRecord(message)))
      .execute('run');
  }

  async lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageSchema,
      { publishedAt: null, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
      {
        ...FRESH,
        orderBy: { occurredAt: 'asc', id: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return records.map((record) => outboxMessageFromRecord(record));
  }

  async markPublished(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const affected = await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: { $in: [...ids] }, publishedAt: null },
      { publishedAt: at, nextAttemptAt: null },
    );
    if (affected !== ids.length) {
      throw new DomainInvariantError(`outbox: ${ids.length} mensagens para marcar, ${affected} marcadas`);
    }
  }

  async saveRetry(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt ?? null },
    );
  }
}

@Injectable()
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(InboxMessageSchema)
      .insert(inboxMessageToRecord(message))
      .onConflict()
      .ignore()
      .execute('run');
    return result.affectedRows === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageSchema, { consumerName, messageId }, FRESH);
    return record === null ? undefined : inboxMessageFromRecord(record);
  }
}
