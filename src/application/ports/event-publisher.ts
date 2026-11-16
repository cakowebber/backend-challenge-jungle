import type { OutboxMessage } from '../../domain/outbox-message';

export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<ReadonlyMap<string, string>>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
