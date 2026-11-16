import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports/event-publisher';
import type { OutboxMessage } from '../../domain/outbox-message';

/** Limite do SQS para um SendMessageBatch. */
const MAX_BATCH_ENTRIES = 10;

/**
 * Publica os eventos de integração numa fila SQS FIFO.
 *
 * - Corpo: o envelope do evento (eventId, eventType, aggregateId,
 *   correlationId, occurredAt, version, data), exatamente como foi gravado na
 *   outbox.
 * - MessageDeduplicationId = eventId: se o mesmo evento for reenviado em até
 *   5 minutos, o próprio SQS descarta a cópia. Depois disso a duplicata chega,
 *   e o consumidor deduplica pelo eventId do envelope.
 * - MessageGroupId = aggregateId: eventos do mesmo agregado ficam no mesmo
 *   grupo. Isso NÃO garante ordem de ponta a ponta: com vários publishers, a
 *   ordem de envio entre eles não é garantida (ver ARCHITECTURE.md).
 * - Um SendMessageBatch por lote, com prazo: a linha da outbox fica travada
 *   enquanto o envio não volta.
 */
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
        // O envio inteiro falhou (rede, SQS fora, prazo). Não sabemos se algo
        // chegou: tudo conta como não publicado e será reenviado.
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

      // Só conta como publicado o que o SQS confirmou explicitamente.
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
