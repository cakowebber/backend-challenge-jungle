import type { InboxMessage } from '../../domain/inbox-message';
import type { Money } from '../../domain/money';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface WalletLedgerSnapshot {
  storedBalance: Money;
  credits: Money;
  debits: Money;
  entries: number;
}

export interface WalletRepository {
  insertIfAbsent(wallet: Wallet): Promise<boolean>;

  findById(id: string): Promise<Wallet | undefined>;

  lockById(id: string): Promise<Wallet | undefined>;

  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;

  ledgerSnapshot(id: string): Promise<WalletLedgerSnapshot | undefined>;
}

export interface WagerTransactionRepository {
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;

  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;

  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;

  saveOutcome(transaction: WagerTransaction): Promise<void>;

  findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]>;
}

export interface PendingReferenceCandidate {
  transactionId: string;
  walletId: string;
}

export interface PositionedLedgerEntry {
  entry: WalletLedgerEntry;
  position: string;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;

  listByWallet(
    walletId: string,
    options: { afterPosition: string | undefined; limit: number },
  ): Promise<PositionedLedgerEntry[]>;
}

export interface OutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;

  lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>;

  markPublished(ids: readonly string[], at: Date): Promise<void>;

  saveRetry(message: OutboxMessage): Promise<void>;
}

export interface InboxRepository {
  insertIfAbsent(message: InboxMessage): Promise<boolean>;

  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
export const INBOX_REPOSITORY = Symbol('INBOX_REPOSITORY');
export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');
export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');
export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');
