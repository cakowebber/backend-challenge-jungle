import { RequestContext } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError, TransientFailureError, type TransientReason } from '../../application/errors';
import { METRICS, MetricName, type Metrics } from '../../application/ports/observability';
import type { UnitOfWork } from '../../application/ports/unit-of-work';

/**
 * Estratégia transacional: `em.fork().transactional(...)`.
 *
 * - O fork dá a cada unidade de trabalho um EntityManager próprio, com identity
 *   map vazio: nada lido antes (fora do lock) é reaproveitado lá dentro.
 * - O MikroORM guarda o EntityManager da transação em AsyncLocalStorage. Os
 *   repositórios recebem o EntityManager global por injeção e, dentro do
 *   callback, ele resolve sozinho para o da transação — por isso ninguém passa
 *   "tx" por parâmetro.
 * - Isolamento READ COMMITTED (padrão do Postgres). A serialização por wallet
 *   vem do SELECT ... FOR UPDATE, então não é preciso SERIALIZABLE com retry.
 */
@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly em: EntityManager,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async transactional<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await this.em.fork().transactional(() => work());
    } catch (error) {
      throw this.translate(error);
    }
  }

  async session<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await RequestContext.create(this.em.fork(), () => work());
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Toda transação SQL do sistema passa por aqui, então este é o único lugar
   * que conta conflito de lock — vale para HTTP, fila e workers.
   */
  private translate(error: unknown): unknown {
    const translated = translateDatabaseError(error);
    if (translated instanceof TransientFailureError && LOCK_CONFLICTS.has(translated.reason)) {
      this.metrics.increment(MetricName.LockConflicts, { reason: translated.reason });
    }
    return translated;
  }
}

/** Falhas transitórias causadas por disputa de lock (banco fora do ar não entra). */
const LOCK_CONFLICTS: ReadonlySet<TransientReason> = new Set(['LOCK_TIMEOUT', 'DEADLOCK', 'CONCURRENT_UPDATE']);

/** SQLSTATEs que significam "tente de novo": nada foi commitado. */
const TRANSIENT_SQL_STATES: Readonly<Record<string, TransientReason>> = {
  '55P03': 'LOCK_TIMEOUT', // lock_not_available: estourou lock_timeout esperando a wallet
  '40P01': 'DEADLOCK', // deadlock_detected
  '40001': 'CONCURRENT_UPDATE', // serialization_failure
  '57014': 'DATABASE_UNAVAILABLE', // query_canceled (statement_timeout)
  '57P01': 'DATABASE_UNAVAILABLE', // admin_shutdown
  '57P02': 'DATABASE_UNAVAILABLE', // crash_shutdown
  '57P03': 'DATABASE_UNAVAILABLE', // cannot_connect_now
  '53300': 'DATABASE_UNAVAILABLE', // too_many_connections
};

const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

/**
 * Traduz erro do driver para o vocabulário da aplicação. Só reclassifica o que
 * é comprovadamente transitório; todo o resto sobe como veio (e vira 500).
 */
export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof ApplicationError) {
    return error;
  }
  const reason = transientReason(error);
  return reason === undefined ? error : new TransientFailureError(reason, { cause: error });
}

function transientReason(error: unknown): TransientReason | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    const known = TRANSIENT_SQL_STATES[code];
    if (known !== undefined) return known;
    if (code.startsWith('08') || NETWORK_ERROR_CODES.has(code)) return 'DATABASE_UNAVAILABLE'; // 08xxx: conexão
  }
  // O pool do pg não usa código quando esgota o prazo para obter conexão.
  if (/timeout exceeded when trying to connect|Connection terminated/i.test(error.message)) {
    return 'DATABASE_UNAVAILABLE';
  }
  return undefined;
}
