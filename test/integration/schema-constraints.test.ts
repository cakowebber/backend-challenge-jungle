import type { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  balanceOf,
  debit,
  insertLedgerEntry,
  insertTransaction,
  insertWallet,
  ledgerRow,
  openWallet,
  transactionRow,
  uuid,
  walletRow,
} from '../support/sql-fixtures';
import { expectViolation, migratedTestDatabase, SqlState } from '../support/test-database';

let sql: SQL;

beforeAll(async () => {
  sql = await migratedTestDatabase('schema_constraints');
});

afterAll(async () => {
  await sql.close();
});

const unique = (constraint: string) => ({ sqlState: SqlState.UniqueViolation, constraint });
const check = (constraint: string) => ({ sqlState: SqlState.CheckViolation, constraint });
const foreignKey = (constraint: string) => ({ sqlState: SqlState.ForeignKeyViolation, constraint });
const guard = (constraint: string) => ({ sqlState: SqlState.IntegrityConstraintViolation, constraint });

async function count(table: string, where: string, value: string): Promise<number> {
  const [row] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE ${where} = $1`, [value]);
  return row.n as number;
}

describe('wallets', () => {
  test('UNIQUE (player_id, currency): segunda wallet do mesmo player e moeda é recusada', async () => {
    const first = await openWallet(sql, '0.00');

    await expectViolation(
      () => insertWallet(sql, walletRow({ player_id: first.player_id, currency: 'BRL' })),
      unique('wallets_player_currency_key'),
    );
  });

  test('o mesmo player pode ter wallets em moedas diferentes', async () => {
    const brl = await openWallet(sql, '0.00');

    await insertWallet(sql, walletRow({ player_id: brl.player_id, currency: 'USD' }));

    expect(await count('wallets', 'player_id', brl.player_id)).toBe(2);
  });

  test('criações simultâneas para o mesmo player e moeda: exatamente uma vence', async () => {
    const playerId = `player-${uuid()}`;

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => insertWallet(sql, walletRow({ player_id: playerId }))),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await count('wallets', 'player_id', playerId)).toBe(1);
  });

  test('CHECK (balance >= 0): não nasce com saldo negativo', async () => {
    await expectViolation(
      () => insertWallet(sql, walletRow({ balance: '-0.01' })),
      check('wallets_balance_non_negative'),
    );
  });

  test('CHECK (balance >= 0): um débito maior que o saldo é recusado e o saldo fica intacto', async () => {
    const wallet = await openWallet(sql, '20.00');

    await expectViolation(
      () => sql`UPDATE wallets SET balance = balance - 20.01 WHERE id = ${wallet.id}`,
      check('wallets_balance_non_negative'),
    );
    expect(await balanceOf(sql, wallet.id)).toBe('20.00');
  });

  test('version começa em 1 e a moeda segue o formato ISO', async () => {
    await expectViolation(() => insertWallet(sql, walletRow({ version: 0 })), check('wallets_version_positive'));
    await expectViolation(() => insertWallet(sql, walletRow({ currency: 'brl' })), check('wallets_currency_format'));
  });
});

describe('wager_transactions — idempotência', () => {
  test('UNIQUE (idempotency_key): a mesma key não entra duas vezes', async () => {
    const wallet = await openWallet(sql);
    const first = await insertTransaction(sql, transactionRow(wallet.id));

    await expectViolation(
      () =>
        insertTransaction(
          sql,
          transactionRow(wallet.id, {
            external_transaction_id: `outro-${uuid()}`,
            idempotency_key: first.idempotency_key,
          }),
        ),
      unique('wager_transactions_idempotency_key_key'),
    );
  });

  test('a mesma aposta 50x em paralelo: um INSERT vence, 49 violam a unicidade', async () => {
    const wallet = await openWallet(sql);
    const externalId = `ext-${uuid()}`;

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        insertTransaction(sql, transactionRow(wallet.id, { external_transaction_id: externalId })),
      ),
    );

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(49);
    for (const { reason } of rejected) {
      expect(reason.errno).toBe(SqlState.UniqueViolation);
    }
    expect(await count('wager_transactions', 'external_transaction_id', externalId)).toBe(1);
  });

  test('UNIQUE (provider_id, external_transaction_id): mesma operação com OUTRA key também é recusada', async () => {
    const wallet = await openWallet(sql);
    const first = await insertTransaction(sql, transactionRow(wallet.id));

    await expectViolation(
      () =>
        insertTransaction(
          sql,
          transactionRow(wallet.id, {
            external_transaction_id: first.external_transaction_id,
            idempotency_key: `key-nova-${uuid()}`,
          }),
        ),
      unique('wager_transactions_provider_external_key'),
    );
  });

  test('provedores diferentes podem usar o mesmo id externo', async () => {
    const wallet = await openWallet(sql);
    const externalId = `ext-${uuid()}`;

    await insertTransaction(sql, transactionRow(wallet.id, { provider_id: 'provider-a', external_transaction_id: externalId }));
    await insertTransaction(sql, transactionRow(wallet.id, { provider_id: 'provider-b', external_transaction_id: externalId }));

    expect(await count('wager_transactions', 'external_transaction_id', externalId)).toBe(2);
  });
});

describe('wager_transactions — coerência', () => {
  test('FK: não existe transação para wallet inexistente', async () => {
    await expectViolation(
      () => insertTransaction(sql, transactionRow(uuid())),
      foreignKey('wager_transactions_wallet_fkey'),
    );
  });

  test('kind e status só aceitam os valores do domínio', async () => {
    const wallet = await openWallet(sql);

    await expectViolation(
      () => insertTransaction(sql, transactionRow(wallet.id, { kind: 'CASHBACK' })),
      check('wager_transactions_kind_valid'),
    );
    await expectViolation(
      () => insertTransaction(sql, transactionRow(wallet.id, { status: 'DONE', processed_at: null })),
      check('wager_transactions_status_valid'),
    );
  });

  test('valor nunca é negativo, e zero só é aceito em LOSS', async () => {
    const wallet = await openWallet(sql);

    await expectViolation(
      () => insertTransaction(sql, transactionRow(wallet.id, { amount: '-1.00' })),
      check('wager_transactions_amount_valid'),
    );
    await expectViolation(
      () => insertTransaction(sql, transactionRow(wallet.id, { kind: 'BET', amount: '0.00' })),
      check('wager_transactions_amount_valid'),
    );
    await insertTransaction(sql, transactionRow(wallet.id, { kind: 'LOSS', amount: '0.00' }));
  });

  test('REFUND e ROLLBACK exigem referência; BET não pode ter', async () => {
    const wallet = await openWallet(sql);

    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expectViolation(
        () => insertTransaction(sql, transactionRow(wallet.id, { kind, status: 'PENDING', processed_at: null })),
        check('wager_transactions_reference_by_kind'),
      );
    }
    await expectViolation(
      () =>
        insertTransaction(
          sql,
          transactionRow(wallet.id, {
            kind: 'BET',
            reference_external_transaction_id: 'x',
            status: 'PENDING',
            processed_at: null,
          }),
        ),
      check('wager_transactions_reference_by_kind'),
    );
  });

  test('REJECTED e FAILED exigem failure_code; os demais estados não podem ter', async () => {
    const wallet = await openWallet(sql);

    await expectViolation(
      () => insertTransaction(sql, transactionRow(wallet.id, { status: 'REJECTED', processed_at: null })),
      check('wager_transactions_failure_code_by_status'),
    );
    await expectViolation(
      () => insertTransaction(sql, transactionRow(wallet.id, { failure_code: 'INSUFFICIENT_FUNDS' })),
      check('wager_transactions_failure_code_by_status'),
    );
  });

  test('PROCESSED exige processed_at, e só PROCESSED tem', async () => {
    const wallet = await openWallet(sql);

    await expectViolation(
      () => insertTransaction(sql, transactionRow(wallet.id, { processed_at: null })),
      check('wager_transactions_processed_at_by_status'),
    );
    await expectViolation(
      () => insertTransaction(sql, transactionRow(wallet.id, { status: 'PENDING' })),
      check('wager_transactions_processed_at_by_status'),
    );
  });

  test('reversão PROCESSED precisa ter a referência resolvida', async () => {
    const wallet = await openWallet(sql);

    await expectViolation(
      () =>
        insertTransaction(
          sql,
          transactionRow(wallet.id, { kind: 'REFUND', reference_external_transaction_id: 'bet-1' }),
        ),
      check('wager_transactions_processed_reference_resolved'),
    );
  });

  test('PENDING_REFERENCE exige próxima tentativa agendada, e só ele tem', async () => {
    const wallet = await openWallet(sql);
    const pending = { kind: 'ROLLBACK', reference_external_transaction_id: 'bet-1', processed_at: null };

    await expectViolation(
      () => insertTransaction(sql, transactionRow(wallet.id, { ...pending, status: 'PENDING_REFERENCE' })),
      check('wager_transactions_pending_reference_coherent'),
    );
    await expectViolation(
      () =>
        insertTransaction(
          sql,
          transactionRow(wallet.id, { ...pending, status: 'PENDING', next_reference_attempt_at: new Date() }),
        ),
      check('wager_transactions_pending_reference_coherent'),
    );
  });
});

describe('wager_transactions — reversão única por referência', () => {
  function reversalOf(walletId: string, betId: string, kind: 'REFUND' | 'ROLLBACK') {
    return transactionRow(walletId, {
      kind,
      reference_external_transaction_id: 'bet-ext',
      reference_transaction_id: betId,
    });
  }

  test('uma BET reembolsada não aceita um segundo REFUND', async () => {
    const wallet = await openWallet(sql);
    const bet = await insertTransaction(sql, transactionRow(wallet.id));
    await insertTransaction(sql, reversalOf(wallet.id, bet.id, 'REFUND'));

    await expectViolation(
      () => insertTransaction(sql, reversalOf(wallet.id, bet.id, 'REFUND')),
      unique('wager_transactions_single_reversal_key'),
    );
  });

  test('nem um ROLLBACK depois do REFUND (leitura estrita da regra 4)', async () => {
    const wallet = await openWallet(sql);
    const bet = await insertTransaction(sql, transactionRow(wallet.id));
    await insertTransaction(sql, reversalOf(wallet.id, bet.id, 'REFUND'));

    await expectViolation(
      () => insertTransaction(sql, reversalOf(wallet.id, bet.id, 'ROLLBACK')),
      unique('wager_transactions_single_reversal_key'),
    );
  });

  test('duas reversões simultâneas da mesma BET: exatamente uma vence', async () => {
    const wallet = await openWallet(sql);
    const bet = await insertTransaction(sql, transactionRow(wallet.id));

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        insertTransaction(sql, reversalOf(wallet.id, bet.id, i % 2 === 0 ? 'REFUND' : 'ROLLBACK')),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  test('reversão rejeitada não ocupa a vaga: a próxima ainda pode ser aplicada', async () => {
    const wallet = await openWallet(sql);
    const bet = await insertTransaction(sql, transactionRow(wallet.id));
    await insertTransaction(sql, {
      ...reversalOf(wallet.id, bet.id, 'REFUND'),
      status: 'REJECTED',
      failure_code: 'REFERENCE_AMOUNT_MISMATCH',
      processed_at: null,
    });

    await insertTransaction(sql, reversalOf(wallet.id, bet.id, 'REFUND'));
  });

  test('WIN referenciando a mesma BET não conta como reversão', async () => {
    const wallet = await openWallet(sql);
    const bet = await insertTransaction(sql, transactionRow(wallet.id));
    const win = { kind: 'WIN', reference_external_transaction_id: 'bet-ext', reference_transaction_id: bet.id };

    await insertTransaction(sql, transactionRow(wallet.id, win));
    await insertTransaction(sql, transactionRow(wallet.id, win));
    await insertTransaction(sql, reversalOf(wallet.id, bet.id, 'ROLLBACK'));
  });
});

describe('wager_transactions — imutabilidade', () => {
  test.each([
    ['PROCESSED', { status: 'PROCESSED' }],
    ['REJECTED', { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', processed_at: null }],
    ['FAILED', { status: 'FAILED', failure_code: 'PROCESSING_FAILED', processed_at: null }],
  ])('transação %s é terminal: nenhum UPDATE passa', async (_status, state) => {
    const wallet = await openWallet(sql);
    const tx = await insertTransaction(sql, transactionRow(wallet.id, state));

    await expectViolation(
      () => sql`UPDATE wager_transactions SET status = 'PENDING_REFERENCE' WHERE id = ${tx.id}`,
      guard('wager_transactions_terminal_immutable'),
    );
    await expectViolation(
      () => sql`UPDATE wager_transactions SET reference_attempts = 99 WHERE id = ${tx.id}`,
      guard('wager_transactions_terminal_immutable'),
    );
  });

  async function pendingReference() {
    const wallet = await openWallet(sql);
    const bet = await insertTransaction(sql, transactionRow(wallet.id));
    const refund = await insertTransaction(
      sql,
      transactionRow(wallet.id, {
        kind: 'REFUND',
        reference_external_transaction_id: bet.external_transaction_id,
        status: 'PENDING_REFERENCE',
        processed_at: null,
        next_reference_attempt_at: new Date(),
      }),
    );
    return { bet, refund };
  }

  test('PENDING_REFERENCE pode avançar para PROCESSED', async () => {
    const { bet, refund } = await pendingReference();

    await sql`
      UPDATE wager_transactions
         SET status = 'PROCESSED', processed_at = now(), reference_transaction_id = ${bet.id},
             next_reference_attempt_at = NULL
       WHERE id = ${refund.id}`;

    const [row] = await sql`SELECT status FROM wager_transactions WHERE id = ${refund.id}`;
    expect(row.status).toBe('PROCESSED');
  });

  test('mas não pode voltar para PENDING', async () => {
    const { refund } = await pendingReference();

    await expectViolation(
      () =>
        sql`UPDATE wager_transactions SET status = 'PENDING', next_reference_attempt_at = NULL WHERE id = ${refund.id}`,
      guard('wager_transactions_valid_transition'),
    );
  });

  test('valor, wallet e demais dados de identidade nunca mudam', async () => {
    const { refund } = await pendingReference();
    const otherWallet = await openWallet(sql);

    await expectViolation(
      () => sql`UPDATE wager_transactions SET amount = 9999.00 WHERE id = ${refund.id}`,
      guard('wager_transactions_identity_immutable'),
    );
    await expectViolation(
      () => sql`UPDATE wager_transactions SET wallet_id = ${otherWallet.id} WHERE id = ${refund.id}`,
      guard('wager_transactions_identity_immutable'),
    );
    await expectViolation(
      () => sql`UPDATE wager_transactions SET idempotency_key = 'outra' WHERE id = ${refund.id}`,
      guard('wager_transactions_identity_immutable'),
    );
  });

  test('DELETE é recusado, em qualquer estado', async () => {
    const { bet, refund } = await pendingReference();

    for (const id of [bet.id, refund.id]) {
      await expectViolation(
        () => sql`DELETE FROM wager_transactions WHERE id = ${id}`,
        guard('wager_transactions_no_delete'),
      );
    }
  });

  test('TRUNCATE é recusado, mesmo com CASCADE', async () => {
    const { bet } = await pendingReference();

    let error: { errno?: string; constraint?: string } = {};
    try {
      await sql`TRUNCATE wager_transactions CASCADE`;
    } catch (caught) {
      error = caught as typeof error;
    }

    expect(error.errno).toBe(SqlState.IntegrityConstraintViolation);
    expect(['wager_transactions_no_delete', 'wallet_ledger_entries_append_only']).toContain(error.constraint ?? '');
    expect(await count('wager_transactions', 'id', bet.id)).toBe(1);
  });
});

describe('wallet_ledger_entries', () => {
  test('UNIQUE (wallet_id, transaction_id): a mesma transação não lança duas vezes na wallet', async () => {
    const wallet = await openWallet(sql, '100.00');
    const { transaction } = await debit(sql, wallet, '25.00', '100.00', '75.00');

    await expectViolation(
      () =>
        sql.begin(async (tx) => {
          await tx`UPDATE wallets SET balance = 50.00 WHERE id = ${wallet.id}`;
          await insertLedgerEntry(
            tx,
            ledgerRow(wallet.id, transaction.id, { balance_before: '75.00', balance_after: '50.00' }),
          );
        }),
      unique('wallet_ledger_entries_wallet_transaction_key'),
    );
    expect(await balanceOf(sql, wallet.id)).toBe('75.00');
    expect(await count('wallet_ledger_entries', 'transaction_id', transaction.id)).toBe(1);
  });

  test('append-only: UPDATE é recusado', async () => {
    const wallet = await openWallet(sql, '100.00');
    const { entry } = await debit(sql, wallet, '25.00', '100.00', '75.00');

    await expectViolation(
      () => sql`UPDATE wallet_ledger_entries SET amount = 1.00 WHERE id = ${entry.id}`,
      guard('wallet_ledger_entries_append_only'),
    );
    await expectViolation(
      () => sql`UPDATE wallet_ledger_entries SET amount = amount WHERE id = ${entry.id}`,
      guard('wallet_ledger_entries_append_only'),
    );
  });

  test('append-only: DELETE é recusado', async () => {
    const wallet = await openWallet(sql, '100.00');
    const { entry } = await debit(sql, wallet, '25.00', '100.00', '75.00');

    await expectViolation(
      () => sql`DELETE FROM wallet_ledger_entries WHERE id = ${entry.id}`,
      guard('wallet_ledger_entries_append_only'),
    );
    expect(await count('wallet_ledger_entries', 'id', entry.id)).toBe(1);
  });

  test('append-only: TRUNCATE é recusado', async () => {
    const wallet = await openWallet(sql, '100.00');

    await expectViolation(
      () => sql`TRUNCATE wallet_ledger_entries`,
      guard('wallet_ledger_entries_append_only'),
    );
    expect(await count('wallet_ledger_entries', 'wallet_id', wallet.id)).toBe(1);
  });

  test('append-only: INSERT ... ON CONFLICT DO UPDATE também não sobrescreve', async () => {
    const wallet = await openWallet(sql, '100.00');
    const { entry } = await debit(sql, wallet, '25.00', '100.00', '75.00');

    await expectViolation(
      () => sql`
        INSERT INTO wallet_ledger_entries ${sql(entry)}
        ON CONFLICT (id) DO UPDATE SET amount = 1.00`,
      guard('wallet_ledger_entries_append_only'),
    );
  });

  test('CHECK: a aritmética do lançamento tem que fechar', async () => {
    const wallet = await openWallet(sql, '100.00');
    const tx = await insertTransaction(sql, transactionRow(wallet.id));

    await expectViolation(
      () => insertLedgerEntry(sql, ledgerRow(wallet.id, tx.id, { balance_after: '80.00' })),
      check('wallet_ledger_entries_balanced'),
    );
    await expectViolation(
      () => insertLedgerEntry(sql, ledgerRow(wallet.id, tx.id, { direction: 'CREDIT' })),
      check('wallet_ledger_entries_balanced'),
    );
  });

  test('CHECK: valor positivo, saldos não negativos e direção válida', async () => {
    const wallet = await openWallet(sql, '100.00');
    const tx = await insertTransaction(sql, transactionRow(wallet.id));

    await expectViolation(
      () => insertLedgerEntry(sql, ledgerRow(wallet.id, tx.id, { amount: '0.00', balance_after: '100.00' })),
      check('wallet_ledger_entries_amount_positive'),
    );
    await expectViolation(
      () =>
        insertLedgerEntry(
          sql,
          ledgerRow(wallet.id, tx.id, { amount: '150.00', balance_before: '100.00', balance_after: '-50.00' }),
        ),
      check('wallet_ledger_entries_balances_non_negative'),
    );
    await expectViolation(
      () => insertLedgerEntry(sql, ledgerRow(wallet.id, tx.id, { direction: 'TRANSFER' })),
      check('wallet_ledger_entries_direction_valid'),
    );
  });

  test('FK: o lançamento é sempre na moeda da wallet', async () => {
    const wallet = await openWallet(sql, '100.00');
    const tx = await insertTransaction(sql, transactionRow(wallet.id));

    await expectViolation(
      () => insertLedgerEntry(sql, ledgerRow(wallet.id, tx.id, { currency: 'USD' })),
      foreignKey('wallet_ledger_entries_wallet_fkey'),
    );
  });

  test('FK: não existe lançamento sem a transação que o causou', async () => {
    const wallet = await openWallet(sql, '100.00');

    await expectViolation(
      () => insertLedgerEntry(sql, ledgerRow(wallet.id, uuid())),
      foreignKey('wallet_ledger_entries_transaction_fkey'),
    );
  });

  test('seq cresce a cada lançamento da wallet (cursor estável)', async () => {
    const wallet = await openWallet(sql, '100.00');
    await debit(sql, wallet, '10.00', '100.00', '90.00');
    await debit(sql, wallet, '10.00', '90.00', '80.00');

    const rows = await sql`
      SELECT seq, balance_after::text FROM wallet_ledger_entries WHERE wallet_id = ${wallet.id} ORDER BY seq`;

    expect(rows.map((row: { balance_after: string }) => row.balance_after)).toEqual(['100.00', '90.00', '80.00']);
    const seqs = rows.map((row: { seq: string }) => BigInt(row.seq));
    expect(seqs[0]! < seqs[1]! && seqs[1]! < seqs[2]!).toBe(true);
  });
});

describe('saldo e ledger andam juntos (checado no COMMIT)', () => {
  const mismatch = guard('wallet_balance_matches_ledger');

  test('mover o saldo sem lançamento: o commit é recusado e o saldo volta', async () => {
    const wallet = await openWallet(sql, '100.00');

    await expectViolation(
      () => sql`UPDATE wallets SET balance = 500.00 WHERE id = ${wallet.id}`,
      mismatch,
    );
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
  });

  test('gravar lançamento sem mover o saldo: o commit é recusado e o lançamento não fica', async () => {
    const wallet = await openWallet(sql, '100.00');
    const tx = await insertTransaction(sql, transactionRow(wallet.id));

    await expectViolation(() => insertLedgerEntry(sql, ledgerRow(wallet.id, tx.id)), mismatch);
    expect(await count('wallet_ledger_entries', 'transaction_id', tx.id)).toBe(0);
  });

  test('wallet com saldo inicial e sem lançamento de abertura não é criada', async () => {
    const wallet = walletRow({ balance: '1000.00' });

    await expectViolation(() => insertWallet(sql, wallet), mismatch);
    expect(await count('wallets', 'id', wallet.id)).toBe(0);
  });

  test('saldo e lançamento que não batem entre si são recusados', async () => {
    const wallet = await openWallet(sql, '100.00');

    await expectViolation(
      () =>
        sql.begin(async (tx) => {
          const bet = await insertTransaction(tx, transactionRow(wallet.id));
          await tx`UPDATE wallets SET balance = 70.00 WHERE id = ${wallet.id}`;
          await insertLedgerEntry(tx, ledgerRow(wallet.id, bet.id));
        }),
      mismatch,
    );
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
  });

  test('a checagem é adiada: dentro da transação, a ordem entre saldo e lançamento não importa', async () => {
    const wallet = await openWallet(sql, '100.00');

    await sql.begin(async (tx) => {
      const bet = await insertTransaction(tx, transactionRow(wallet.id));
      await insertLedgerEntry(tx, ledgerRow(wallet.id, bet.id));
      await tx`UPDATE wallets SET balance = 75.00 WHERE id = ${wallet.id}`;
    });
    await debit(sql, wallet, '25.00', '75.00', '50.00');

    expect(await balanceOf(sql, wallet.id)).toBe('50.00');
  });

  test('wallet zerada e sem lançamentos é consistente', async () => {
    const wallet = await openWallet(sql, '0.00');

    expect(await balanceOf(sql, wallet.id)).toBe('0.00');
    expect(await count('wallet_ledger_entries', 'wallet_id', wallet.id)).toBe(0);
  });

  test('invariante final: saldo == soma do ledger', async () => {
    const wallet = await openWallet(sql, '100.00');
    await debit(sql, wallet, '80.00', '100.00', '20.00');
    await debit(sql, wallet, '0.01', '20.00', '19.99');

    const [row] = await sql`
      SELECT w.balance::text,
             (SELECT sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)::text
                FROM wallet_ledger_entries WHERE wallet_id = w.id) AS from_ledger
        FROM wallets w WHERE w.id = ${wallet.id}`;

    expect(row.balance).toBe('19.99');
    expect(row.from_ledger).toBe('19.99');
  });
});

describe('inbox_messages', () => {
  const message = (overrides: Record<string, unknown> = {}) => ({
    consumer_name: 'wager-consumer',
    message_id: `msg-${uuid()}`,
    payload_hash: 'sha256:fixture',
    received_at: new Date(),
    ...overrides,
  });

  test('PK (consumer_name, message_id): a mesma mensagem não é registrada duas vezes', async () => {
    const first = message();
    await sql`INSERT INTO inbox_messages ${sql(first)}`;

    await expectViolation(() => sql`INSERT INTO inbox_messages ${sql(first)}`, unique('inbox_messages_pkey'));
  });

  test('consumidores diferentes registram a mesma mensagem de forma independente', async () => {
    const first = message();

    await sql`INSERT INTO inbox_messages ${sql(first)}`;
    await sql`INSERT INTO inbox_messages ${sql({ ...first, consumer_name: 'outro-consumer' })}`;

    expect(await count('inbox_messages', 'message_id', first.message_id)).toBe(2);
  });

  test('redelivery simultânea: 20 entregas da mesma mensagem, uma só é aceita', async () => {
    const delivered = message();

    const results = await Promise.all(
      Array.from(
        { length: 20 },
        () => sql`INSERT INTO inbox_messages ${sql(delivered)} ON CONFLICT DO NOTHING RETURNING message_id`,
      ),
    );

    expect(results.filter((rows) => rows.length === 1)).toHaveLength(1);
    expect(await count('inbox_messages', 'message_id', delivered.message_id)).toBe(1);
  });
});

describe('outbox_messages', () => {
  const event = (overrides: Record<string, unknown> = {}) => ({
    id: uuid(),
    aggregate_id: uuid(),
    event_type: 'WagerTransactionProcessed',
    payload: { eventType: 'WagerTransactionProcessed', version: 1 },
    occurred_at: new Date(),
    ...overrides,
  });

  async function planOf(query: string): Promise<string> {
    return sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      await tx`SET LOCAL enable_sort = off`;
      const rows = await tx.unsafe(`EXPLAIN ${query}`);
      return rows.map((row: Record<string, string>) => row['QUERY PLAN']).join('\n');
    });
  }

  test('o índice de pendentes é parcial: cobre apenas published_at IS NULL', async () => {
    const [index] = await sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'outbox_messages_pending_idx'`;

    expect(index.indexdef).toContain('(occurred_at, id)');
    expect(index.indexdef).toContain('WHERE (published_at IS NULL)');
  });

  test('a consulta do publisher é atendida pelo índice parcial; a de publicadas, não', async () => {
    await sql`INSERT INTO outbox_messages ${sql(event())}`;

    const pending = await planOf(
      `SELECT id FROM outbox_messages WHERE published_at IS NULL ORDER BY occurred_at, id LIMIT 50`,
    );
    const published = await planOf(
      `SELECT id FROM outbox_messages WHERE published_at IS NOT NULL ORDER BY occurred_at, id LIMIT 50`,
    );

    expect(pending).toContain('outbox_messages_pending_idx');
    expect(published).not.toContain('outbox_messages_pending_idx');
  });

  test('mensagem publicada sai do conjunto de pendentes', async () => {
    const pending = event();
    const published = event({ published_at: new Date() });
    await sql`INSERT INTO outbox_messages ${sql(pending)}`;
    await sql`INSERT INTO outbox_messages ${sql(published)}`;

    const rows = await sql`
      SELECT id FROM outbox_messages
       WHERE published_at IS NULL AND id IN (${pending.id}, ${published.id})`;

    expect(rows.map((row: { id: string }) => row.id)).toEqual([pending.id]);
  });

  test('o id do evento é único: o mesmo evento não entra duas vezes na outbox', async () => {
    const first = event();
    await sql`INSERT INTO outbox_messages ${sql(first)}`;

    await expectViolation(() => sql`INSERT INTO outbox_messages ${sql(first)}`, unique('outbox_messages_pkey'));
  });

  test('attempts não é negativo e mensagem publicada não tem retry agendado', async () => {
    await expectViolation(
      () => sql`INSERT INTO outbox_messages ${sql(event({ attempts: -1 }))}`,
      check('outbox_messages_attempts_non_negative'),
    );
    await expectViolation(
      () =>
        sql`INSERT INTO outbox_messages ${sql(event({ published_at: new Date(), next_attempt_at: new Date() }))}`,
      check('outbox_messages_published_has_no_retry'),
    );
  });
});

describe('wager_transactions — índice do worker de PENDING_REFERENCE', () => {
  test('é parcial: cobre apenas as transações aguardando referência', async () => {
    const [index] = await sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'wager_transactions_pending_reference_idx'`;

    expect(index.indexdef).toContain('(next_reference_attempt_at)');
    expect(index.indexdef).toContain(`WHERE (status = 'PENDING_REFERENCE'::text)`);
  });
});
