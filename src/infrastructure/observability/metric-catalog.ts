import { MetricName } from '../../application/ports/observability';

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricDefinition {
  readonly type: MetricType;
  readonly help: string;
  readonly labels?: readonly string[];
  readonly buckets?: readonly number[];
}

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

const DELAY_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300] as const;

export const GaugeName = {
  OutboxPending: 'outbox_pending_events',
  OutboxLag: 'outbox_lag_seconds',
  PendingReferences: 'wager_pending_reference_transactions',
  DlqMessages: 'wager_dlq_messages',
  QueueMessages: 'wager_queue_messages',
} as const;

export const METRIC_CATALOG: Readonly<Record<string, MetricDefinition>> = {
  [MetricName.TransactionsByStatus]: {
    type: 'counter',
    help: 'Desfechos de transação gravados por esta instância, por status.',
    labels: ['status'],
  },
  [MetricName.DuplicatesDetected]: {
    type: 'counter',
    help: 'Reenvios reconhecidos pela idempotência (replay com o resultado original).',
  },
  [MetricName.LockConflicts]: {
    type: 'counter',
    help: 'Transações SQL abortadas por conflito de lock (lock_timeout, deadlock, atualização concorrente).',
    labels: ['reason'],
  },
  [MetricName.WalletLockWait]: {
    type: 'histogram',
    help: 'Tempo para obter o lock da wallet (SELECT ... FOR UPDATE), em segundos.',
    buckets: DURATION_BUCKETS,
  },
  [MetricName.TransactionDuration]: {
    type: 'histogram',
    help: 'Duração do processamento de uma transação até depois do COMMIT, em segundos, por origem e desfecho.',
    labels: ['source', 'outcome'],
    buckets: DURATION_BUCKETS,
  },
  [MetricName.ReconciliationDivergences]: {
    type: 'counter',
    help: 'Reconciliações em que o saldo gravado diverge do ledger.',
  },
  [MetricName.MessagesByOutcome]: {
    type: 'counter',
    help: 'Mensagens da fila tratadas por esta instância, por desfecho.',
    labels: ['outcome'],
  },
  [MetricName.MessageRetries]: {
    type: 'counter',
    help: 'Mensagens devolvidas à fila para nova tentativa, por motivo.',
    labels: ['reason'],
  },
  [MetricName.MessagesDeadLettered]: {
    type: 'counter',
    help: 'Mensagens enviadas à DLQ por esta instância, por motivo.',
    labels: ['reason'],
  },
  [MetricName.OutboxPublished]: {
    type: 'counter',
    help: 'Eventos da outbox publicados por esta instância.',
  },
  [MetricName.OutboxPublishFailures]: {
    type: 'counter',
    help: 'Publicações da outbox que falharam e foram reagendadas.',
  },
  [MetricName.OutboxPublishDelay]: {
    type: 'histogram',
    help: 'Tempo entre o evento ocorrer e ser publicado, em segundos.',
    buckets: DELAY_BUCKETS,
  },
  [MetricName.ReferenceRetries]: {
    type: 'counter',
    help: 'Tentativas do worker de PENDING_REFERENCE, por desfecho.',
    labels: ['outcome'],
  },
  [MetricName.HttpRequestDuration]: {
    type: 'histogram',
    help: 'Duração das requisições HTTP, em segundos, por método, rota e status.',
    labels: ['method', 'route', 'status'],
    buckets: DURATION_BUCKETS,
  },
  [MetricName.MetricsCollectionErrors]: {
    type: 'counter',
    help: 'Falhas ao ler do banco ou do SQS os valores de /metrics; os gauges da origem ficam ausentes.',
    labels: ['source'],
  },
  [GaugeName.OutboxPending]: {
    type: 'gauge',
    help: 'Eventos na outbox ainda não publicados.',
  },
  [GaugeName.OutboxLag]: {
    type: 'gauge',
    help: 'Outbox lag: idade, em segundos, do evento não publicado mais antigo (0 se não há pendentes).',
  },
  [GaugeName.PendingReferences]: {
    type: 'gauge',
    help: 'Transações em PENDING_REFERENCE aguardando a referência.',
  },
  [GaugeName.DlqMessages]: {
    type: 'gauge',
    help: 'Mensagens na DLQ agora (inclui as movidas pela redrive policy do SQS).',
  },
  [GaugeName.QueueMessages]: {
    type: 'gauge',
    help: 'Mensagens na fila de entrada agora, por estado (visible, in_flight).',
    labels: ['state'],
  },
};
