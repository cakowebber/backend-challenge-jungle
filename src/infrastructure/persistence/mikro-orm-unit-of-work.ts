import { RequestContext } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError, TransientFailureError, type TransientReason } from '../../application/errors';
import { METRICS, MetricName, type Metrics } from '../../application/ports/observability';
import type { UnitOfWork } from '../../application/ports/unit-of-work';

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

  private translate(error: unknown): unknown {
    const translated = translateDatabaseError(error);
    if (translated instanceof TransientFailureError && LOCK_CONFLICTS.has(translated.reason)) {
      this.metrics.increment(MetricName.LockConflicts, { reason: translated.reason });
    }
    return translated;
  }
}

const LOCK_CONFLICTS: ReadonlySet<TransientReason> = new Set(['LOCK_TIMEOUT', 'DEADLOCK', 'CONCURRENT_UPDATE']);

const TRANSIENT_SQL_STATES: Readonly<Record<string, TransientReason>> = {
  '55P03': 'LOCK_TIMEOUT',
  '40P01': 'DEADLOCK',
  '40001': 'CONCURRENT_UPDATE',
  '57014': 'DATABASE_UNAVAILABLE',
  '57P01': 'DATABASE_UNAVAILABLE',
  '57P02': 'DATABASE_UNAVAILABLE',
  '57P03': 'DATABASE_UNAVAILABLE',
  '53300': 'DATABASE_UNAVAILABLE',
};

const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

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
    if (code.startsWith('08') || NETWORK_ERROR_CODES.has(code)) return 'DATABASE_UNAVAILABLE';
  }
  if (/timeout exceeded when trying to connect|Connection terminated/i.test(error.message)) {
    return 'DATABASE_UNAVAILABLE';
  }
  return undefined;
}
