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

/** Espera antes de tentar de novo quando o próprio SQS falha. */
const RECEIVE_ERROR_DELAY_MS = 1_000;

/**
 * Consumer da fila wager-transactions.fifo.
 *
 * - N workers; cada um recebe UMA mensagem por vez. Em fila FIFO, um lote traz
 *   várias mensagens do mesmo grupo, e as que vêm atrás de uma mensagem que
 *   falha gastariam tentativas só por terem sido recebidas junto, até irem
 *   para a DLQ com ela. Recebendo uma por vez, a seguinte do grupo nem é
 *   entregue enquanto a da frente está em andamento, e a ordem é preservada.
 * - O ack (DeleteMessage) só acontece depois que o handler retorna, ou seja,
 *   depois do COMMIT. Se o processo morrer entre os dois, o SQS reentrega e a
 *   inbox descarta.
 * - No shutdown: para de buscar, espera o que está em andamento até um prazo e
 *   devolve à fila o que não terminou.
 * - O long poll em curso NUNCA é abortado: o cliente desistir não cancela o
 *   poll no servidor, que ainda entrega uma mensagem para a conexão morta — ela
 *   some pelo tempo de visibilidade e gasta uma tentativa. O worker deixa o
 *   poll terminar (no máximo waitTimeSeconds) e devolve o que vier.
 */
@Injectable()
export class SqsWagerConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private controller: AbortController | undefined;
  private workers: Promise<void>[] = [];
  /** Long polls em curso, para o shutdown esperar que terminem sozinhos. */
  private readonly polls = new Set<Promise<unknown>>();
  /** Mensagens em processamento, por receipt handle. */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Devolvidas à fila no shutdown: o desfecho tardio do handler é ignorado. */
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

  /** Roda antes de o pool do banco fechar: as mensagens em andamento ainda conseguem commitar. */
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

    // 1. Para de buscar: nenhum worker inicia um novo long poll.
    controller.abort();

    // 2. Dá tempo para o que está em andamento terminar (commit + ack).
    const graceTimer = new AbortController();
    const drained = await Promise.race([
      Promise.allSettled([...this.inFlight.values()]).then(() => true),
      abortableSleep(this.env.consumer.shutdownGraceMs, graceTimer.signal).then(() => false),
    ]);
    // Cancela o timer do prazo: pendente, ele manteria o processo vivo depois do shutdown.
    graceTimer.abort();

    // 3. Espera os long polls em curso retornarem (no máximo waitTimeSeconds).
    //    O que eles trouxerem é devolvido na hora, sem processar. Tem que vir
    //    antes do passo 4: um poll ainda aberto pegaria de volta a mensagem
    //    que acabamos de devolver, gastando uma tentativa dela à toa.
    await Promise.allSettled([...this.polls]);

    // 4. O que não terminou volta para a fila agora, em vez de esperar a
    //    visibilidade expirar. Se o commit ainda acontecer, a redelivery é
    //    descartada pela inbox.
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
        // O SQS falhou (rede, serviço fora). Nada foi recebido: só espera e tenta de novo.
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
      // O poll terminou depois do pedido de parada: devolve sem começar.
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
      // O handler classifica todos os erros; se ele mesmo falhar, a mensagem
      // fica na fila e a redrive policy do broker é a rede de segurança.
      this.logger.error('falha ao classificar a mensagem', { reason: describe(error) });
      disposition = {
        action: 'RETRY',
        reason: 'HANDLER_FAILURE',
        delaySeconds: this.env.consumer.retryBaseDelaySeconds,
        pauseConsumption: false,
      };
    }

    if (this.released.delete(receiptHandle)) {
      return; // já foi devolvida à fila no shutdown
    }

    try {
      await this.settle(message, disposition, receiveCount);
    } catch (error) {
      // Não conseguiu apagar, adiar ou mover: a mensagem reaparece quando a
      // visibilidade expirar, e o reprocessamento é seguro (inbox + idempotência).
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
        // Envia para a DLQ e só então apaga da fila principal. Se morrer entre
        // os dois, a mensagem é reprocessada e reenviada: o id de deduplicação
        // evita a cópia dupla na DLQ.
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

  /**
   * O limite de tentativas vive em dois lugares: aqui (SQS_MAX_ATTEMPTS) e na
   * redrive policy da fila. Se divergirem, avisa — o broker moveria a mensagem
   * para a DLQ antes de o consumer gravar o FAILED, ou depois.
   */
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
      // só diagnóstico: não impede o consumo
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
