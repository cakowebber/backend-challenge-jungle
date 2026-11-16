import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { requireEnv } from '../../src/infrastructure/config/env';
import type { TransactionPayload } from './test-app';

/**
 * Filas FIFO reais no LocalStack, um par (principal + DLQ com redrive policy)
 * por arquivo de teste, para os testes não disputarem mensagens entre si nem
 * com a fila de desenvolvimento.
 */
export class TestQueues {
  private constructor(
    private readonly sqs: SQSClient,
    readonly queueUrl: string,
    readonly dlqUrl: string,
    /** Fila FIFO de saída, onde o outbox publisher publica os eventos. */
    readonly eventsUrl: string,
  ) {}

  static async create(suite: string, maxReceiveCount: number): Promise<TestQueues> {
    const sqs = new SQSClient({ region: requireEnv('AWS_REGION'), endpoint: requireEnv('SQS_ENDPOINT') });
    const unique = `${suite}-${Date.now()}`;
    try {
      const dlq = await sqs.send(
        new CreateQueueCommand({ QueueName: `test-${unique}-dlq.fifo`, Attributes: { FifoQueue: 'true' } }),
      );
      const dlqUrl = dlq.QueueUrl as string;
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
      );
      const queue = await sqs.send(
        new CreateQueueCommand({
          QueueName: `test-${unique}.fifo`,
          Attributes: {
            FifoQueue: 'true',
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes?.QueueArn, maxReceiveCount }),
          },
        }),
      );
      const events = await sqs.send(
        new CreateQueueCommand({ QueueName: `test-${unique}-events.fifo`, Attributes: { FifoQueue: 'true' } }),
      );
      return new TestQueues(sqs, queue.QueueUrl as string, dlqUrl, events.QueueUrl as string);
    } catch (error) {
      sqs.destroy();
      throw new Error('Não foi possível criar as filas de teste. O LocalStack do docker compose está no ar?', {
        cause: error,
      });
    }
  }

  /** Envia um corpo cru. Cada envio é uma mensagem SQS nova (id de deduplicação único). */
  async sendRaw(body: string, group = 'default'): Promise<string> {
    const result = await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: body,
        MessageGroupId: group,
        MessageDeduplicationId: Bun.randomUUIDv7(),
      }),
    );
    return result.MessageId as string;
  }

  /** Envia uma mensagem WagerTransactionRequested bem formada. Devolve o messageId do corpo. */
  async send(
    payload: TransactionPayload,
    options: { messageId?: string; idempotencyKey?: string; group?: string } = {},
  ): Promise<string> {
    const messageId = options.messageId ?? `msg-${Bun.randomUUIDv7()}`;
    await this.sendRaw(wagerMessageBody(payload, { ...options, messageId }), options.group ?? payload.walletId);
    return messageId;
  }

  /** Recebe direto da fila, sem passar pelo consumer (ex.: para simular um worker que morre). */
  async receive(queueUrl: string, options: { waitSeconds?: number; visibilitySeconds?: number } = {}): Promise<Message[]> {
    const result = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: options.waitSeconds ?? 1,
        ...(options.visibilitySeconds === undefined ? {} : { VisibilityTimeout: options.visibilitySeconds }),
        MessageSystemAttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    return result.Messages ?? [];
  }

  /** Lê e REMOVE as mensagens visíveis da fila (para conferir a DLQ sem deixar restos para o próximo teste). */
  async drain(queueUrl: string, waitSeconds = 2): Promise<Message[]> {
    const drained: Message[] = [];
    for (;;) {
      const batch = await this.receive(queueUrl, { waitSeconds: drained.length === 0 ? waitSeconds : 0 });
      if (batch.length === 0) {
        return drained;
      }
      for (const message of batch) {
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle as string }));
        drained.push(message);
      }
    }
  }

  /** Mensagens na fila: visíveis + em processamento. */
  async depth(queueUrl: string): Promise<number> {
    const { Attributes } = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return (
      Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
      Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
    );
  }

  async destroy(): Promise<void> {
    await Promise.allSettled([
      this.sqs.send(new DeleteQueueCommand({ QueueUrl: this.queueUrl })),
      this.sqs.send(new DeleteQueueCommand({ QueueUrl: this.dlqUrl })),
      this.sqs.send(new DeleteQueueCommand({ QueueUrl: this.eventsUrl })),
    ]);
    this.sqs.destroy();
  }
}

export function wagerMessageBody(
  payload: TransactionPayload,
  options: { messageId: string; idempotencyKey?: string },
): string {
  return JSON.stringify({
    messageId: options.messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      ...payload,
      idempotencyKey: options.idempotencyKey ?? `${payload.providerId}:${payload.externalTransactionId}`,
    },
  });
}

/** Espera uma condição assíncrona ficar verdadeira, sondando. Falha com a descrição se o prazo estourar. */
export async function eventually(
  description: string,
  condition: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`não aconteceu em ${timeoutMs}ms: ${description}`);
}
