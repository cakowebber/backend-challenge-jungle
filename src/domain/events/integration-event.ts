import { requireNonEmpty } from '../errors';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
  data: T;
}

/** Metadados de rastreio que quem emite o evento fornece. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
}

/** Envelope serializado: é exatamente o que vai para o payload da outbox. */
export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  version: number;
  data: T;
}

/**
 * Base dos eventos de integração. `eventType` e `version` pertencem ao tipo
 * (cada subclasse fixa os seus), nunca a uma string solta no ponto de emissão.
 * `data` só carrega valores serializáveis — dinheiro vai como MoneyProps.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = requireNonEmpty('eventId', props.eventId);
    this.aggregateId = requireNonEmpty('aggregateId', props.aggregateId);
    this.correlationId = requireNonEmpty('correlationId', props.correlationId);
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
