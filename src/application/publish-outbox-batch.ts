import type { BackoffPolicy } from '../domain/backoff';
import type { OutboxMessage } from '../domain/outbox-message';
import type { Clock } from './ports/clock';
import type { EventPublisher } from './ports/event-publisher';
import { MetricName, type Metrics } from './ports/observability';
import type { OutboxRepository } from './ports/repositories';
import type { UnitOfWork } from './ports/unit-of-work';

export const OUTBOX_PUBLISH_SETTINGS = Symbol('OUTBOX_PUBLISH_SETTINGS');

export interface OutboxPublishSettings {
  /** Mensagens por ciclo. */
  batchSize: number;
  /** Backoff de uma publicação que falhou. Não há limite de tentativas. */
  retry: BackoffPolicy;
}

export interface PublishOutboxResult {
  /** Mensagens que este ciclo travou. */
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Um ciclo do outbox publisher. Tudo em UMA transação SQL:
 *
 *   1. trava um lote de pendentes (FOR UPDATE SKIP LOCKED);
 *   2. publica;
 *   3. marca as aceitas como publicadas e agenda nova tentativa para as demais;
 *   4. COMMIT.
 *
 * Por que o lock fica aberto durante o envio: é ele que impede dois publishers
 * de enviarem a mesma mensagem, e ele some sozinho se o processo morrer.
 *
 * Se o processo morrer entre 2 e 4, a transação sofre rollback, a mensagem
 * continua pendente e será publicada DE NOVO, com o mesmo id. A entrega é
 * "pelo menos uma vez": nunca se perde um evento confirmado, e a duplicata é
 * identificável pelo eventId. Marcar antes de publicar inverteria isso — uma
 * queda perderia o evento.
 *
 * Os eventos só existem na tabela depois do commit da transação de negócio
 * (READ COMMITTED), então nada é publicado antes do commit.
 */
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
    /** Segundos entre cada evento ocorrer e ser publicado neste ciclo. */
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

    // Métricas só depois do commit: se a transação falhar, nada foi marcado.
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

  /**
   * Uma falha de envio NÃO aborta a transação: ela precisa commitar para
   * gravar o backoff de cada mensagem. Se o envio inteiro falhar (rede, SQS
   * fora, prazo estourado), o lote todo conta como não publicado — mesmo que
   * alguma mensagem tenha chegado ao destino, caso em que será republicada.
   */
  private async send(batch: readonly OutboxMessage[]): Promise<ReadonlyMap<string, string>> {
    try {
      return await this.publisher.publish(batch);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return new Map(batch.map((message) => [message.id, reason]));
    }
  }
}
