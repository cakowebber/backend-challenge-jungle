import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports/event-publisher';
import type { OutboxMessage } from '../../domain/outbox-message';

const MAX_BATCH_ENTRIES = 10;

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly sendTimeoutMs: number,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<ReadonlyMap<string, string>> {
    const failures = new Map<string, string>();
    for (let start = 0; start < messages.length; start += MAX_BATCH_ENTRIES) {
      const chunk = messages.slice(start, start + MAX_BATCH_ENTRIES);
      try {
        await this.sendChunk(chunk, failures);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const message of chunk) {
          failures.set(message.id, reason);
        }
      }
    }
    return failures;
  }

  private async sendChunk(chunk: readonly OutboxMessage[], failures: Map<string, string>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.sendTimeoutMs);
    try {
      const result = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: chunk.map((message) => ({
            Id: message.id,
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: message.eventType },
            },
          })),
        }),
        { abortSignal: controller.signal },
      );

      const accepted = new Set((result.Successful ?? []).map((entry) => entry.Id));
      const rejected = new Map((result.Failed ?? []).map((entry) => [entry.Id, entry.Code ?? 'FAILED']));
      for (const message of chunk) {
        if (!accepted.has(message.id)) {
          failures.set(message.id, rejected.get(message.id) ?? 'NOT_CONFIRMED');
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
