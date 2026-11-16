export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

export interface AppLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export type MetricLabels = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: string, labels?: MetricLabels, by?: number): void;
  observe(name: string, seconds: number, labels?: MetricLabels): void;
}

export const APP_LOGGER = Symbol('APP_LOGGER');
export const METRICS = Symbol('METRICS');

export const MetricName = {
  TransactionsByStatus: 'wager_transactions_total',
  DuplicatesDetected: 'wager_duplicates_detected_total',
  LockConflicts: 'wager_lock_conflicts_total',
  WalletLockWait: 'wallet_lock_wait_seconds',
  TransactionDuration: 'wager_transaction_duration_seconds',
  ReconciliationDivergences: 'wallet_reconciliation_divergences_total',
  MessagesByOutcome: 'wager_messages_total',
  MessageRetries: 'wager_message_retries_total',
  MessagesDeadLettered: 'wager_messages_dead_lettered_total',
  OutboxPublished: 'outbox_events_published_total',
  OutboxPublishFailures: 'outbox_publish_failures_total',
  OutboxPublishDelay: 'outbox_publish_delay_seconds',
  ReferenceRetries: 'wager_reference_retries_total',
  HttpRequestDuration: 'http_request_duration_seconds',
  MetricsCollectionErrors: 'metrics_collection_errors_total',
} as const;
