import { SQL } from 'bun';
import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { requireEnv } from '../../src/infrastructure/config/env';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm-config';

function databaseUrl(name: string): string {
  const url = new URL(requireEnv('DATABASE_URL'));
  url.pathname = `/${name}`;
  return url.toString();
}

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

export async function openOrm(url: string): Promise<MikroORM> {
  const config = createOrmConfig({ url });
  return MikroORM.init({ ...config, migrations: { ...config.migrations, silent: true } });
}

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

export const SqlState = {
  UniqueViolation: '23505',
  CheckViolation: '23514',
  ForeignKeyViolation: '23503',
  IntegrityConstraintViolation: '23000',
} as const;
