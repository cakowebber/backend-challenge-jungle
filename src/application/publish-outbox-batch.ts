import type { BackoffPolicy } from '../domain/backoff';
import type { OutboxMessage } from '../domain/outbox-message';
import type { Clock } from './ports/clock';
import type { EventPublisher } from './ports/event-publisher';
import { MetricName, type Metrics } from './ports/observability';
import type { OutboxRepository } from './ports/repositories';
import type { UnitOfWork } from './ports/unit-of-work';

export const OUTBOX_PUBLISH_SETTINGS = Symbol('OUTBOX_PUBLISH_SETTINGS');

export interface OutboxPublishSettings {
  batchSize: number;
  retry: BackoffPolicy;
}

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  failed: number;
}

export class PublishOutboxBatch {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly settings: OutboxPublishSettings,
  ) {}

  async execute(): Promise<PublishOutboxResult> {
    const delays: number[] = [];

    const result = await this.unitOfWork.transactional(async (): Promise<PublishOutboxResult> => {
      const batch = await this.outbox.lockDueBatch(this.clock.now(), this.settings.batchSize);
      if (batch.length === 0) {
        return { claimed: 0, published: 0, failed: 0 };
      }

      const failures = await this.send(batch);
      const now = this.clock.now();

      const published: OutboxMessage[] = [];
      for (const message of batch) {
        if (failures.has(message.id)) {
          message.scheduleRetry(now, this.settings.retry);
          await this.outbox.saveRetry(message);
        } else {
          message.markPublished(now);
          published.push(message);
          delays.push(Math.max(0, now.getTime() - message.occurredAt.getTime()) / 1000);
        }
      }
      await this.outbox.markPublished(
        published.map((message) => message.id),
        now,
      );

      return { claimed: batch.length, published: published.length, failed: batch.length - published.length };
    });

    if (result.published > 0) {
      this.metrics.increment(MetricName.OutboxPublished, {}, result.published);
      for (const delay of delays) {
        this.metrics.observe(MetricName.OutboxPublishDelay, delay);
      }
    }
    if (result.failed > 0) {
      this.metrics.increment(MetricName.OutboxPublishFailures, {}, result.failed);
    }
    return result;
  }

  private async send(batch: readonly OutboxMessage[]): Promise<ReadonlyMap<string, string>> {
    try {
      return await this.publisher.publish(batch);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return new Map(batch.map((message) => [message.id, reason]));
    }
  }
}
