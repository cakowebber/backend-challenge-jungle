import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { openOrm, recreateTestDatabase } from '../support/test-database';

const TABLES = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];

let orm: MikroORM;
let sql: SQL;

beforeAll(async () => {
  const url = await recreateTestDatabase('migrations');
  orm = await openOrm(url);
  sql = new SQL(url);
});

afterAll(async () => {
  await sql.close();
  await orm.close();
});

/** Tudo que as migrations criam no schema public, fora a tabela de controle do migrator. */
async function schemaObjects() {
  const tables = await sql`
    SELECT tablename AS name FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations' ORDER BY 1`;
  const functions = await sql`
    SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' ORDER BY 1`;
  const triggers = await sql`
    SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY 1`;
  const indexes = await sql`
    SELECT indexname AS name FROM pg_indexes
     WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations' ORDER BY 1`;
  const names = (rows: { name: string }[]) => rows.map((row) => row.name);
  return {
    tables: names(tables),
    functions: names(functions),
    triggers: names(triggers),
    indexes: names(indexes),
  };
}

async function appliedMigrations(): Promise<string[]> {
  const rows = await sql`SELECT name FROM mikro_orm_migrations ORDER BY id`;
  return rows.map((row: { name: string }) => row.name);
}

describe('migrations', () => {
  test('up em banco vazio cria as 5 tabelas, as funções, os triggers e os índices', async () => {
    await orm.migrator.up();

    const schema = await schemaObjects();
    expect(schema.tables).toEqual(TABLES);
    expect(schema.functions).toEqual([
      'assert_wallet_balance_matches_ledger',
      'wager_transactions_guard',
      'wallet_ledger_entries_append_only',
    ]);
    expect(schema.triggers).toEqual([
      'wager_transactions_guard_row',
      'wager_transactions_guard_truncate',
      'wallet_ledger_entries_append_only_row',
      'wallet_ledger_entries_append_only_truncate',
      'wallet_ledger_entries_balance_matches_wallet',
      'wallets_balance_matches_ledger',
    ]);
    expect(schema.indexes).toContain('outbox_messages_pending_idx');
    expect(schema.indexes).toContain('wager_transactions_single_reversal_key');
    expect(schema.indexes).toContain('wager_transactions_pending_reference_idx');
    expect(await appliedMigrations()).toHaveLength(5);
  });

  test('up de novo é idempotente: nada pendente, nada reaplicado', async () => {
    const applied = await orm.migrator.up();

    expect(applied).toEqual([]);
    expect(await appliedMigrations()).toHaveLength(5);
  });

  test('down reverte uma migration por vez, na ordem inversa', async () => {
    await orm.migrator.down();

    expect((await schemaObjects()).tables).toEqual(TABLES.filter((table) => table !== 'outbox_messages'));
    expect(await appliedMigrations()).toHaveLength(4);
  });

  test('down até o início não deixa tabela, função, trigger nem índice para trás', async () => {
    await orm.migrator.down({ to: 0 });

    expect(await schemaObjects()).toEqual({ tables: [], functions: [], triggers: [], indexes: [] });
    expect(await appliedMigrations()).toEqual([]);
  });

  test('depois de revertido, o up volta a montar o schema completo', async () => {
    await orm.migrator.up();

    const schema = await schemaObjects();
    expect(schema.tables).toEqual(TABLES);
    expect(schema.triggers).toHaveLength(6);
    expect(await appliedMigrations()).toHaveLength(5);
  });
});
