import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { migrations } from './migrations';
import { entitySchemas } from './records';

export interface DatabaseSettings {
  url: string;
  poolMax?: number;
  lockTimeoutMs?: number;
}

export const DEFAULT_POOL_MAX = 10;
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

const STATEMENT_TIMEOUT_MS = 15_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;
const POOL_ACQUIRE_TIMEOUT_MS = 5_000;

export function createOrmConfig(settings: DatabaseSettings) {
  const lockTimeoutMs = settings.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  return defineConfig({
    clientUrl: settings.url,

    entities: entitySchemas,

    pool: { min: 0, max: settings.poolMax ?? DEFAULT_POOL_MAX },
    driverOptions: {
      connectionTimeoutMillis: POOL_ACQUIRE_TIMEOUT_MS,
      options: [
        `-c lock_timeout=${lockTimeoutMs}`,
        `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
        `-c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
      ].join(' '),
    },

    extensions: [Migrator],
    migrations: {
      migrationsList: migrations,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
