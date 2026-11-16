import { DomainInvariantError } from './errors';

export interface BackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface ReferenceRetryPolicy extends BackoffPolicy {
  readonly maxAttempts: number;
}

export function backoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new DomainInvariantError(`tentativa de backoff inválida: ${attempt}`);
  }
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
}

export function nextAttemptAt(now: Date, attempt: number, policy: BackoffPolicy): Date {
  return new Date(now.getTime() + backoffDelayMs(attempt, policy));
}
