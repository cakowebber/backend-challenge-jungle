import { SQL } from 'bun';
import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { requireEnv } from '../../src/infrastructure/config/env';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm-config';

/**
 * Infra dos testes de integração: Postgres REAL (o do docker compose), nunca mock.
 *
 * Cada arquivo de teste recebe um banco próprio, recriado do zero e migrado pelo
 * migrator da aplicação. Não há limpeza entre testes — TRUNCATE é bloqueado no
 * ledger de propósito —, então cada teste cria as suas próprias wallets.
 */

function databaseUrl(name: string): string {
  const url = new URL(requireEnv('DATABASE_URL'));
  url.pathname = `/${name}`;
  return url.toString();
}

/** Derruba e recria o banco `wagering_test_<suite>`. Devolve a URL dele. */
export async function recreateTestDatabase(suite: string): Promise<string> {
  const name = `wagering_test_${suite}`;
  const admin = new SQL(requireEnv('DATABASE_URL'));
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } catch (error) {
    throw new Error(
      `Não foi possível preparar o banco de teste "${name}". O Postgres do docker compose está no ar? ` +
        `(docker compose up -d postgres)`,
      { cause: error },
    );
  } finally {
    await admin.close();
  }
  return databaseUrl(name);
}

/** ORM apontado para o banco de teste, com o log do migrator silenciado. */
export async function openOrm(url: string): Promise<MikroORM> {
  const config = createOrmConfig({ url });
  return MikroORM.init({ ...config, migrations: { ...config.migrations, silent: true } });
}

/** Banco recém-criado com todas as migrations aplicadas, pronto para SQL direto. */
export async function migratedTestDatabase(suite: string): Promise<SQL> {
  const url = await recreateTestDatabase(suite);
  const orm = await openOrm(url);
  try {
    await orm.migrator.up();
  } finally {
    await orm.close();
  }
  return new SQL(url);
}

/**
 * Executa a ação e exige que o BANCO a recuse com este SQLSTATE e esta
 * constraint. Conferir o nome garante que foi a regra certa que barrou.
 */
export async function expectViolation(
  action: () => Promise<unknown>,
  expected: { sqlState: string; constraint: string },
): Promise<void> {
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(SQL.PostgresError);
  const { errno, constraint } = error as SQL.PostgresError;
  expect({ sqlState: errno, constraint }).toEqual(expected);
}

/** SQLSTATEs usados nas asserções. */
export const SqlState = {
  UniqueViolation: '23505',
  CheckViolation: '23514',
  ForeignKeyViolation: '23503',
  /** Usado pelos nossos triggers (RAISE ... ERRCODE = 'integrity_constraint_violation'). */
  IntegrityConstraintViolation: '23000',
} as const;
