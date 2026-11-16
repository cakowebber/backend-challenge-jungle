import { nextAttemptAt, type BackoffPolicy } from './backoff';
import { DomainInvariantError } from './errors';
import type { IntegrationEvent } from './events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

/**
 * Evento aguardando publicação. É gravado na mesma transação SQL da mudança
 * que o originou e publicado depois do commit por um worker.
 *
 * Não existe limite de tentativas: um evento confirmado não pode ser perdido,
 * então a publicação é repetida com backoff até dar certo.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  /** O id da mensagem é o eventId: o consumidor usa esse id para deduplicar. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze({ ...event.toJSON() }),
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pendente e sem espera de backoff em aberto. Recém-criada está sempre devida. */
  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this.assertPending('markPublished');
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Publicação falhou: incrementa attempts e calcula o próximo nextAttemptAt (backoff). */
  scheduleRetry(now: Date, policy: BackoffPolicy): void {
    this.assertPending('scheduleRetry');
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt(now, this._attempts, policy);
  }

  private assertPending(attempted: string): void {
    if (!this.isPending()) {
      throw new DomainInvariantError(`mensagem de outbox ${this.id} já foi publicada e não aceita ${attempted}`);
    }
  }
}
