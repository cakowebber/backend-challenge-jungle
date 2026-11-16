import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { APP_LOGGER, METRICS, MetricName, type AppLogger, type Metrics } from '../../application/ports/observability';
import { ENV, type Env } from '../config/env';
import { SQS_CLIENT } from '../messaging/sqs.provider';
import { GaugeName } from './metric-catalog';
import type { GaugeSample } from './prometheus-metrics';

/** Uma origem que não responde neste prazo fica sem os seus gauges neste scrape. */
const COLLECT_TIMEOUT_MS = 2_000;

/**
 * Valores que são ESTADO GLOBAL, não eventos de uma instância: quantos eventos
 * esperam na outbox e há quanto tempo, quantas mensagens estão na DLQ. Um
 * contador em memória não responde isso (cada instância só vê o que ela mesma
 * fez), então eles são lidos do banco e do SQS a cada GET /metrics. Todas as
 * instâncias devolvem o mesmo valor.
 *
 * Banco ou SQS fora não derrubam o /metrics: os gauges daquela origem ficam
 * ausentes no scrape e `metrics_collection_errors_total` sobe.
 */
@Injectable()
export class OperationalGauges {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  async collect(): Promise<GaugeSample[]> {
    const [database, queues] = await Promise.all([
      this.guarded('postgres', () => this.fromDatabase()),
      this.guarded('sqs', (signal) => this.fromQueues(signal)),
    ]);
    return [...database, ...queues];
  }

  /**
   * Um único comando SQL = um único instante do banco. As três contagens usam
   * índices parciais (só pendentes), então o custo acompanha o que está
   * pendente e não o histórico.
   *
   * O lag usa o relógio do banco contra o `occurred_at` gravado pela
   * aplicação; uma diferença pequena de relógio não pode dar lag negativo.
   */
  private async fromDatabase(): Promise<GaugeSample[]> {
    const [row] = await this.orm.em.getConnection().execute<
      { outbox_pending: string; outbox_lag_seconds: string; pending_references: string }[]
    >(
      `SELECT (SELECT count(*) FROM outbox_messages WHERE published_at IS NULL) AS outbox_pending,
              (SELECT COALESCE(GREATEST(EXTRACT(EPOCH FROM (now() - min(occurred_at))), 0), 0)
                 FROM outbox_messages WHERE published_at IS NULL) AS outbox_lag_seconds,
              (SELECT count(*) FROM wager_transactions WHERE status = 'PENDING_REFERENCE') AS pending_references`,
    );
    return [
      { name: GaugeName.OutboxPending, value: Number(row?.outbox_pending ?? 0) },
      { name: GaugeName.OutboxLag, value: Number(row?.outbox_lag_seconds ?? 0) },
      { name: GaugeName.PendingReferences, value: Number(row?.pending_references ?? 0) },
    ];
  }

  private async fromQueues(signal: AbortSignal): Promise<GaugeSample[]> {
    const attributes = async (queueUrl: string) => {
      const { Attributes } = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
        { abortSignal: signal },
      );
      return {
        visible: Number(Attributes?.ApproximateNumberOfMessages ?? 0),
        inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
      };
    };
    const [dlq, queue] = await Promise.all([attributes(this.env.wagerDlqUrl), attributes(this.env.wagerQueueUrl)]);
    return [
      { name: GaugeName.DlqMessages, value: dlq.visible + dlq.inFlight },
      { name: GaugeName.QueueMessages, labels: { state: 'visible' }, value: queue.visible },
      { name: GaugeName.QueueMessages, labels: { state: 'in_flight' }, value: queue.inFlight },
    ];
  }

  private async guarded(
    source: 'postgres' | 'sqs',
    read: (signal: AbortSignal) => Promise<GaugeSample[]>,
  ): Promise<GaugeSample[]> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`sem resposta em ${COLLECT_TIMEOUT_MS}ms`));
      }, COLLECT_TIMEOUT_MS);
    });

    try {
      return await Promise.race([read(controller.signal), timeout]);
    } catch (error) {
      this.metrics.increment(MetricName.MetricsCollectionErrors, { source });
      this.logger.warn('métricas: falha ao ler os valores da origem', {
        source,
        reason: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}
