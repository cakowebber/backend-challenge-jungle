import type { FailureCode } from '../../domain/failure-code';
import { InboxMessage } from '../../domain/inbox-message';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry, type LedgerDirection } from '../../domain/wallet-ledger-entry';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

/**
 * Conversão registro <-> domínio. A volta do banco usa sempre `rehydrate`,
 * que reconstrói o estado sem revalidar regras de transição.
 * Os valores de kind/status/direction são garantidos pelos CHECKs do schema.
 */

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });

// ---- Wallet

export function walletToRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function walletFromRecord(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    balance: money(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

// ---- WagerTransaction

/** Campos que mudam ao longo da vida da transação; os demais são imutáveis (e o banco garante). */
export function transactionOutcomeToRecord(
  transaction: WagerTransaction,
): Pick<
  WagerTransactionRecord,
  | 'status'
  | 'referenceTransactionId'
  | 'failureCode'
  | 'processedAt'
  | 'observedBalanceAmount'
  | 'observedBalanceCurrency'
  | 'referenceAttempts'
  | 'nextReferenceAttemptAt'
> {
  const observed = transaction.observedBalance?.toJSON();
  return {
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    processedAt: transaction.processedAt ?? null,
    observedBalanceAmount: observed?.amount ?? null,
    observedBalanceCurrency: observed?.currency ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
  };
}

export function transactionToRecord(transaction: WagerTransaction): WagerTransactionRecord {
  const value = transaction.money.toJSON();
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: value.amount,
    currency: value.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    createdAt: transaction.createdAt,
    ...transactionOutcomeToRecord(transaction),
  };
}

export function transactionFromRecord(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: money(record.amount, record.currency),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: record.processedAt ?? undefined,
    observedBalance:
      record.observedBalanceAmount !== null && record.observedBalanceCurrency !== null
        ? money(record.observedBalanceAmount, record.observedBalanceCurrency)
        : undefined,
    referenceAttempts: record.referenceAttempts,
    nextReferenceAttemptAt: record.nextReferenceAttemptAt ?? undefined,
  });
}

// ---- WalletLedgerEntry

export function ledgerEntryToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  const value = entry.money.toJSON();
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: value.amount,
    currency: value.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}

export function ledgerEntryFromRecord(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBefore, record.currency),
    balanceAfter: money(record.balanceAfter, record.currency),
    createdAt: record.createdAt,
  });
}

// ---- OutboxMessage

export function outboxMessageToRecord(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
  };
}

export function outboxMessageFromRecord(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt ?? undefined,
    publishedAt: record.publishedAt ?? undefined,
  });
}

// ---- InboxMessage

export function inboxMessageToRecord(message: InboxMessage): InboxMessageRecord {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

export function inboxMessageFromRecord(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: record.consumerName,
    messageId: record.messageId,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: record.processedAt ?? undefined,
  });
}
