import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_LOGGER, METRICS, MetricName, type AppLogger, type Metrics } from '../../application/ports/observability';
import { ENV, type Env } from '../config/env';
import { ReadinessService } from '../health/readiness.service';
import { abortableSleep, ConsumptionGate } from './consumption-gate';
import { SQS_CLIENT } from './sqs.provider';
import { WagerMessageHandler, type MessageDisposition } from './wager-message-handler';

const RECEIVE_ERROR_DELAY_MS = 1_000;

@Injectable()
export class SqsWagerConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private controller: AbortController | undefined;
  private workers: Promise<void>[] = [];
  private readonly polls = new Set<Promise<unknown>>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly released = new Set<string>();
  private readonly gate: ConsumptionGate;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
    private readonly handler: WagerMessageHandler,
    readiness: ReadinessService,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {
    this.gate = new ConsumptionGate(() => readiness.isPostgresUp());
  }

  get isRunning(): boolean {
    return this.controller !== undefined;
  }

  get isPaused(): boolean {
    return this.gate.isClosed;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  onApplicationBootstrap(): void {
    if (this.env.consumer.enabled) {
      this.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.controller !== undefined) {
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.workers = Array.from({ length: this.env.consumer.concurrency }, () => this.work(controller.signal));
    this.logger.info('consumer iniciado', {
      concurrency: this.env.consumer.concurrency,
      maxAttempts: this.env.consumer.maxAttempts,
    });
    void this.warnIfRedrivePolicyDiffers();
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    if (controller === undefined) {
      return;
    }
    this.controller = undefined;

    controller.abort();

    const graceTimer = new AbortController();
    const drained = await Promise.race([
      Promise.allSettled([...this.inFlight.values()]).then(() => true),
      abortableSleep(this.env.consumer.shutdownGraceMs, graceTimer.signal).then(() => false),
    ]);
    graceTimer.abort();

    await Promise.allSettled([...this.polls]);

    if (!drained) {
      const stuck = [...this.inFlight.keys()];
      for (const receiptHandle of stuck) {
        this.released.add(receiptHandle);
      }
      await Promise.allSettled(stuck.map((receiptHandle) => this.changeVisibility(receiptHandle, 0)));
      this.logger.warn('shutdown: mensagens em andamento devolvidas à fila', { count: stuck.length });
    }
    this.logger.info('consumer parado');
  }

  private async work(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.gate.waitUntilOpen(signal);
        if (signal.aborted) {
          break;
        }
        const message = await this.receive();
        if (message !== undefined) {
          await this.track(message, signal);
        }
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        this.logger.warn('falha ao receber mensagens', { reason: describe(error) });
        await abortableSleep(RECEIVE_ERROR_DELAY_MS, signal);
      }
    }
  }

  private async receive(): Promise<Message | undefined> {
    const poll = this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.env.wagerQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: this.env.consumer.waitTimeSeconds,
        VisibilityTimeout: this.env.consumer.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
    );
    this.polls.add(poll);
    try {
      return (await poll).Messages?.[0];
    } finally {
      this.polls.delete(poll);
    }
  }

  private async track(message: Message, signal: AbortSignal): Promise<void> {
    const receiptHandle = message.ReceiptHandle as string;
    if (signal.aborted) {
      await this.changeVisibility(receiptHandle, 0).catch(() => undefined);
      return;
    }

    const done = this.process(message).finally(() => {
      this.inFlight.delete(receiptHandle);
    });
    this.inFlight.set(receiptHandle, done);
    await done;
  }

  private async process(message: Message): Promise<void> {
    const receiptHandle = message.ReceiptHandle as string;
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    let disposition: MessageDisposition;
    try {
      disposition = await this.handler.handle({
        body: message.Body ?? '',
        sqsMessageId: message.MessageId,
        receiveCount,
      });
    } catch (error) {
      this.logger.error('falha ao classificar a mensagem', { reason: describe(error) });
      disposition = {
        action: 'RETRY',
        reason: 'HANDLER_FAILURE',
        delaySeconds: this.env.consumer.retryBaseDelaySeconds,
        pauseConsumption: false,
      };
    }

    if (this.released.delete(receiptHandle)) {
      return;
    }

    try {
      await this.settle(message, disposition, receiveCount);
    } catch (error) {
      this.logger.warn('falha ao concluir a mensagem no SQS', {
        action: disposition.action,
        reason: describe(error),
      });
    }
  }

  private async settle(message: Message, disposition: MessageDisposition, receiveCount: number): Promise<void> {
    const receiptHandle = message.ReceiptHandle as string;

    switch (disposition.action) {
      case 'ACK':
        await this.delete(receiptHandle);
        return;

      case 'RETRY':
        this.metrics.increment(MetricName.MessageRetries, { reason: disposition.reason });
        if (disposition.pauseConsumption) {
          this.gate.close();
        }
        await this.changeVisibility(receiptHandle, disposition.delaySeconds);
        return;

      case 'DEAD_LETTER':
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: this.env.wagerDlqUrl,
            MessageBody: message.Body ?? '(vazio)',
            MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
            MessageDeduplicationId: message.MessageId as string,
            MessageAttributes: {
              DeadLetterReason: { DataType: 'String', StringValue: disposition.reason },
              DeadLetterDetail: { DataType: 'String', StringValue: disposition.detail.slice(0, 1000) || '-' },
              ReceiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
            },
          }),
        );
        await this.delete(receiptHandle);
        this.metrics.increment(MetricName.MessagesDeadLettered, { reason: disposition.reason });
        return;
    }
  }

  private async delete(receiptHandle: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.env.wagerQueueUrl, ReceiptHandle: receiptHandle }));
  }

  private async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.env.wagerQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private async warnIfRedrivePolicyDiffers(): Promise<void> {
    try {
      const { Attributes } = await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: this.env.wagerQueueUrl, AttributeNames: ['RedrivePolicy'] }),
      );
      const policy = JSON.parse(Attributes?.RedrivePolicy ?? '{}') as { maxReceiveCount?: string | number };
      if (Number(policy.maxReceiveCount) !== this.env.consumer.maxAttempts) {
        this.logger.warn('maxReceiveCount da fila difere de SQS_MAX_ATTEMPTS', {
          queue: String(policy.maxReceiveCount),
          consumer: this.env.consumer.maxAttempts,
        });
      }
    } catch {
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
