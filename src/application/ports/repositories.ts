import type { InboxMessage } from '../../domain/inbox-message';
import type { Money } from '../../domain/money';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

/** Foto de uma wallet e do seu ledger tirada em um único instante. */
export interface WalletLedgerSnapshot {
  storedBalance: Money;
  credits: Money;
  debits: Money;
  entries: number;
}

export interface WalletRepository {
  /** Insere a wallet. Devolve false se já existe uma para o mesmo player e moeda. */
  insertIfAbsent(wallet: Wallet): Promise<boolean>;

  findById(id: string): Promise<Wallet | undefined>;

  /**
   * Lê a wallet travando a linha (SELECT ... FOR UPDATE) até o fim da transação.
   * É a ÚNICA leitura de saldo usada para calcular um novo saldo.
   */
  lockById(id: string): Promise<Wallet | undefined>;

  /**
   * Grava saldo e versão, condicionado à versão que foi lida sob o lock.
   * Se nenhuma linha for afetada, alguém alterou a wallet fora do lock: aborta.
   */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;

  ledgerSnapshot(id: string): Promise<WalletLedgerSnapshot | undefined>;
}

export interface WagerTransactionRepository {
  /**
   * Insere a transação. Devolve false se o banco a recusou por unicidade
   * (idempotency key ou provider + id externo já existentes).
   */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;

  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;

  /** Já existe uma reversão (REFUND ou ROLLBACK) PROCESSED apontando para esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;

  /** Grava o desfecho (status, referência resolvida, failureCode, saldo observado, tentativas). */
  saveOutcome(transaction: WagerTransaction): Promise<void>;

  /**
   * Transações PENDING_REFERENCE com a próxima tentativa vencida, das mais
   * atrasadas para as menos. Leitura SEM lock: é só a lista de candidatas;
   * quem reprocessa trava a wallet e relê a transação antes de agir.
   */
  findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]>;
}

export interface PendingReferenceCandidate {
  transactionId: string;
  walletId: string;
}

/** Lançamento com a sua posição no ledger (base do cursor de paginação). */
export interface PositionedLedgerEntry {
  entry: WalletLedgerEntry;
  position: string;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;

  /** Lançamentos da wallet em ordem de gravação, depois de `afterPosition`. */
  listByWallet(
    walletId: string,
    options: { afterPosition: string | undefined; limit: number },
  ): Promise<PositionedLedgerEntry[]>;
}

export interface OutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;

  /**
   * Lê e TRAVA até `limit` mensagens pendentes e vencidas, das mais antigas
   * para as mais novas (SELECT ... FOR UPDATE SKIP LOCKED). Linhas travadas
   * por outro publisher são puladas, não esperadas. Exige transação aberta: o
   * lock dura até o commit ou rollback dela.
   */
  lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>;

  /** Marca as mensagens como publicadas em `at`. */
  markPublished(ids: readonly string[], at: Date): Promise<void>;

  /** Grava a tentativa frustrada: attempts e nextAttemptAt. */
  saveRetry(message: OutboxMessage): Promise<void>;
}

export interface InboxRepository {
  /** Registra a mensagem. Devolve false se (consumerName, messageId) já existe. */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;

  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
export const INBOX_REPOSITORY = Symbol('INBOX_REPOSITORY');
export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');
export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');
export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');
