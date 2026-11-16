import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { migrations } from './migrations';
import { entitySchemas } from './records';

export interface DatabaseSettings {
  url: string;
  /** Máximo de conexões do pool, por instância da aplicação. */
  poolMax?: number;
  /** Tempo máximo esperando um lock de linha antes de desistir (vira 503). */
  lockTimeoutMs?: number;
}

export const DEFAULT_POOL_MAX = 10;
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/** Um comando ou uma transação parada não pode segurar um lock de wallet para sempre. */
const STATEMENT_TIMEOUT_MS = 15_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;
/** Espera máxima por uma conexão livre do pool. */
const POOL_ACQUIRE_TIMEOUT_MS = 5_000;

/**
 * Configuração única do MikroORM: usada pela app (MikroOrmModule), pela CLI de
 * migrations (mikro-orm.config.ts) e pelos testes de integração.
 */
export function createOrmConfig(settings: DatabaseSettings) {
  const lockTimeoutMs = settings.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  return defineConfig({
    clientUrl: settings.url,

    // Registros de persistência em lista explícita (EntitySchema), sem discovery
    // por glob e sem decorators. O domínio não conhece o ORM.
    entities: entitySchemas,

    pool: { min: 0, max: settings.poolMax ?? DEFAULT_POOL_MAX },
    driverOptions: {
      connectionTimeoutMillis: POOL_ACQUIRE_TIMEOUT_MS,
      // Parâmetros de sessão aplicados a toda conexão do pool.
      options: [
        `-c lock_timeout=${lockTimeoutMs}`,
        `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
        `-c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
      ].join(' '),
    },

    extensions: [Migrator],
    migrations: {
      // Lista explícita em vez de descoberta por pasta (ver migrations/index.ts).
      migrationsList: migrations,
      // Cada migration roda em transação e o lote inteiro é tudo-ou-nada.
      transactional: true,
      allOrNothing: true,
      // Migrations são SQL escrito à mão (triggers, CHECKs, índices parciais),
      // então não há snapshot de schema para o gerador comparar.
      snapshot: false,
    },
  });
}
