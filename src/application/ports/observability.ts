/**
 * Campos estruturados de log: só valores escalares. Um objeto (por exemplo o
 * payload da transação) não cabe no tipo, e o logger descarta se chegar em
 * tempo de execução. Valor e saldo nunca são campos de log.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

export interface AppLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export type MetricLabels = Readonly<Record<string, string>>;

export interface Metrics {
  /** Incrementa um contador. */
  increment(name: string, labels?: MetricLabels, by?: number): void;
  /** Registra uma duração, em segundos, num histograma. */
  observe(name: string, seconds: number, labels?: MetricLabels): void;
}

export const APP_LOGGER = Symbol('APP_LOGGER');
export const METRICS = Symbol('METRICS');

/**
 * Nomes das métricas, em um lugar só. Tipo, descrição e buckets de cada uma
 * ficam no catálogo da infraestrutura (metric-catalog.ts).
 *
 * Nenhuma métrica usa walletId, providerId ou qualquer id como label: cada
 * valor distinto de label vira uma série, e ids não têm limite.
 */
export const MetricName = {
  /** Desfechos gravados, por status (label `status`). */
  TransactionsByStatus: 'wager_transactions_total',
  DuplicatesDetected: 'wager_duplicates_detected_total',
  /** Espera por lock que terminou em erro (label `reason`: LOCK_TIMEOUT, DEADLOCK, CONCURRENT_UPDATE). */
  LockConflicts: 'wager_lock_conflicts_total',
  /** Tempo para obter o lock da wallet. */
  WalletLockWait: 'wallet_lock_wait_seconds',
  /** Duração do use case de transação, do início até depois do COMMIT (labels `source`, `outcome`). */
  TransactionDuration: 'wager_transaction_duration_seconds',
  ReconciliationDivergences: 'wallet_reconciliation_divergences_total',
  /** Mensagens da fila por desfecho (label `outcome`). */
  MessagesByOutcome: 'wager_messages_total',
  MessageRetries: 'wager_message_retries_total',
  MessagesDeadLettered: 'wager_messages_dead_lettered_total',
  OutboxPublished: 'outbox_events_published_total',
  OutboxPublishFailures: 'outbox_publish_failures_total',
  /** Tempo entre o evento ocorrer e ser publicado. */
  OutboxPublishDelay: 'outbox_publish_delay_seconds',
  /** Tentativas do worker de PENDING_REFERENCE por desfecho (label `outcome`). */
  ReferenceRetries: 'wager_reference_retries_total',
  /** Duração das requisições HTTP (labels `method`, `route`, `status`). */
  HttpRequestDuration: 'http_request_duration_seconds',
  /** Falhas ao ler do banco ou do SQS os valores de /metrics (label `source`). */
  MetricsCollectionErrors: 'metrics_collection_errors_total',
} as const;
