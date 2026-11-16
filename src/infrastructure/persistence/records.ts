import { BigIntType, DecimalType, EntitySchema } from '@mikro-orm/core';

const money = () => ({ type: new DecimalType('string') });

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string' },
    currency: { type: 'string' },
    balance: money(),
    version: { type: 'number' },
    createdAt: { type: 'Date' },
    updatedAt: { type: 'Date' },
  },
});

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  processedAt: Date | null;
  observedBalanceAmount: string | null;
  observedBalanceCurrency: string | null;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | null;
  createdAt: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string' },
    walletId: { type: 'uuid' },
    playerId: { type: 'string' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: money(),
    currency: { type: 'string' },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    processedAt: { type: 'Date', nullable: true },
    observedBalanceAmount: { ...money(), nullable: true },
    observedBalanceCurrency: { type: 'string', nullable: true },
    referenceAttempts: { type: 'number' },
    nextReferenceAttemptAt: { type: 'Date', nullable: true },
    createdAt: { type: 'Date' },
  },
});

export interface LedgerEntryRecord {
  id: string;
  seq?: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    seq: { type: new BigIntType('string'), nullable: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string' },
    amount: money(),
    currency: { type: 'string' },
    balanceBefore: money(),
    balanceAfter: money(),
    createdAt: { type: 'Date' },
  },
});

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'string' },
    payload: { type: 'json' },
    occurredAt: { type: 'Date' },
    attempts: { type: 'number' },
    nextAttemptAt: { type: 'Date', nullable: true },
    publishedAt: { type: 'Date', nullable: true },
  },
});

export interface InboxMessageRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string' },
    receivedAt: { type: 'Date' },
    processedAt: { type: 'Date', nullable: true },
  },
});

export const entitySchemas = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  OutboxMessageSchema,
  InboxMessageSchema,
];
