import { DomainInvariantError } from './errors';

/**
 * Backoff exponencial com teto: base, 2x base, 4x base... até maxDelayMs.
 * Função pura e sem jitter, para o domínio continuar determinístico e testável.
 * Os valores concretos de cada política são definidos por quem agenda
 * (outbox publisher e worker de PENDING_REFERENCE).
 */
export interface BackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** Política do reprocessamento de PENDING_REFERENCE: backoff + limite de tentativas. */
export interface ReferenceRetryPolicy extends BackoffPolicy {
  /** Quantas novas tentativas o worker faz antes de rejeitar com REFERENCE_NOT_FOUND. */
  readonly maxAttempts: number;
}

/** `attempt` começa em 1 (a primeira espera usa o atraso base). */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new DomainInvariantError(`tentativa de backoff inválida: ${attempt}`);
  }
  // O expoente é limitado para 2 ** n não estourar; o teto real é maxDelayMs.
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
}

export function nextAttemptAt(now: Date, attempt: number, policy: BackoffPolicy): Date {
  return new Date(now.getTime() + backoffDelayMs(attempt, policy));
}
