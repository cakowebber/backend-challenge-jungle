import type { SQL } from 'bun';

/**
 * Linhas válidas para inserir com SQL direto nos testes de schema.
 * Cada teste parte de uma linha válida e estraga UM campo, para que a falha
 * seja da constraint em teste e de nenhuma outra.
 */

export interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  processed_at: Date | null;
  observed_balance_amount: string | null;
  observed_balance_currency: string | null;
  reference_attempts: number;
  next_reference_attempt_at: Date | null;
  created_at: Date;
}

export interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

export const uuid = (): string => Bun.randomUUIDv7();

export function walletRow(overrides: Partial<WalletRow> = {}): WalletRow {
  const now = new Date();
  return {
    id: uuid(),
    player_id: `player-${uuid()}`,
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** BET PROCESSED de 25.00 por padrão. */
export function transactionRow(walletId: string, overrides: Partial<TransactionRow> = {}): TransactionRow {
  const id = overrides.id ?? uuid();
  const providerId = overrides.provider_id ?? 'provider-a';
  const externalId = overrides.external_transaction_id ?? `ext-${id}`;
  return {
    id,
    provider_id: providerId,
    external_transaction_id: externalId,
    idempotency_key: `${providerId}:${externalId}`,
    payload_hash: 'sha256:fixture',
    wallet_id: walletId,
    player_id: 'player-fixture',
    round_id: 'round-1',
    game_id: 'fortune-chimp',
    kind: 'BET',
    amount: '25.00',
    currency: 'BRL',
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: 'PROCESSED',
    failure_code: null,
    processed_at: new Date(),
    observed_balance_amount: null,
    observed_balance_currency: null,
    reference_attempts: 0,
    next_reference_attempt_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

/** DEBIT de 25.00 levando o saldo de 100.00 para 75.00, por padrão. */
export function ledgerRow(walletId: string, transactionId: string, overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: uuid(),
    wallet_id: walletId,
    transaction_id: transactionId,
    direction: 'DEBIT',
    amount: '25.00',
    currency: 'BRL',
    balance_before: '100.00',
    balance_after: '75.00',
    created_at: new Date(),
    ...overrides,
  };
}

export async function insertWallet(db: SQL, row: WalletRow): Promise<WalletRow> {
  await db`INSERT INTO wallets ${db(row)}`;
  return row;
}

export async function insertTransaction(db: SQL, row: TransactionRow): Promise<TransactionRow> {
  await db`INSERT INTO wager_transactions ${db(row)}`;
  return row;
}

export async function insertLedgerEntry(db: SQL, row: LedgerRow): Promise<LedgerRow> {
  await db`INSERT INTO wallet_ledger_entries ${db(row)}`;
  return row;
}

/**
 * Abre uma wallet como a aplicação faz: wallet + transação OPENING + lançamento
 * CREDIT na mesma transação SQL. Com saldo zero, só a wallet.
 */
export async function openWallet(sql: SQL, balance = '100.00', overrides: Partial<WalletRow> = {}): Promise<WalletRow> {
  const wallet = walletRow({ balance, ...overrides });

  await sql.begin(async (tx) => {
    await insertWallet(tx, wallet);
    if (balance === '0.00') return;

    const opening = await insertTransaction(
      tx,
      transactionRow(wallet.id, {
        provider_id: 'internal',
        external_transaction_id: `opening:${wallet.id}`,
        kind: 'OPENING',
        amount: balance,
        currency: wallet.currency,
      }),
    );
    await insertLedgerEntry(
      tx,
      ledgerRow(wallet.id, opening.id, {
        direction: 'CREDIT',
        amount: balance,
        currency: wallet.currency,
        balance_before: '0.00',
        balance_after: balance,
      }),
    );
  });
  return wallet;
}

/**
 * Aplica um débito consistente (transação BET + saldo + lançamento) numa wallet
 * que está com `before`. Devolve a transação e o lançamento gravados.
 */
export async function debit(
  sql: SQL,
  wallet: WalletRow,
  amount: string,
  before: string,
  after: string,
): Promise<{ transaction: TransactionRow; entry: LedgerRow }> {
  return sql.begin(async (tx) => {
    const transaction = await insertTransaction(tx, transactionRow(wallet.id, { amount }));
    await tx`UPDATE wallets SET balance = ${after}, version = version + 1 WHERE id = ${wallet.id}`;
    const entry = await insertLedgerEntry(
      tx,
      ledgerRow(wallet.id, transaction.id, { amount, balance_before: before, balance_after: after }),
    );
    return { transaction, entry };
  });
}

/**
 * Saldo como texto exato. O `::text` é necessário: o cliente Postgres do Bun
 * (usado só nestes testes) devolve o NUMERIC 0.00 como "0", perdendo a escala.
 */
export async function balanceOf(sql: SQL, walletId: string): Promise<string> {
  const [row] = await sql`SELECT balance::text FROM wallets WHERE id = ${walletId}`;
  return row.balance as string;
}
