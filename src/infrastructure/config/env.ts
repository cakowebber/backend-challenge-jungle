import { LOG_LEVELS, type LogLevel } from '../observability/json-logger';

/**
 * Configuração lida do ambiente. Sem biblioteca: são poucas variáveis e o
 * comportamento desejado é simples — faltou algo obrigatório, o processo não sobe.
 */
export interface Env {
  readonly port: number;
  /** Nível mínimo de log escrito no stdout. */
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  /** Máximo de conexões do pool por instância. */
  readonly databasePoolMax: number;
  /** Espera máxima por um lock de wallet, em ms. */
  readonly databaseLockTimeoutMs: number;
  readonly awsRegion: string;
  /** Só existe em ambiente local (LocalStack). Na AWS real fica indefinido. */
  readonly sqsEndpoint: string | undefined;
  readonly wagerQueueUrl: string;
  readonly wagerDlqUrl: string;
  /** Fila onde o outbox publisher publica os eventos de integração. */
  readonly eventsQueueUrl: string;
  readonly consumer: ConsumerSettings;
  readonly outbox: OutboxSettings;
  readonly pendingReference: PendingReferenceSettings;
}

export interface OutboxSettings {
  /** Liga o outbox publisher nesta instância. */
  readonly enabled: boolean;
  /** Espera entre ciclos quando não há lote cheio para publicar. */
  readonly pollIntervalMs: number;
  /** Mensagens por ciclo. No máximo 10: é o limite de um SendMessageBatch. */
  readonly batchSize: number;
  /** Backoff de uma publicação que falhou: base dobrando até o teto. Sem limite de tentativas. */
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  /**
   * Prazo do envio ao SQS. A linha da outbox fica travada durante o envio,
   * então o prazo precisa ser bem menor que o idle_in_transaction_session_timeout.
   */
  readonly sendTimeoutMs: number;
}

export interface PendingReferenceSettings {
  /** Liga o worker de PENDING_REFERENCE nesta instância. */
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  /** Transações reprocessadas por ciclo. */
  readonly batchSize: number;
  /** Backoff entre tentativas: base dobrando até o teto. */
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  /** Tentativas do worker antes de rejeitar com REFERENCE_NOT_FOUND. */
  readonly maxAttempts: number;
}

export interface ConsumerSettings {
  /** Liga o consumo da fila nesta instância. */
  readonly enabled: boolean;
  /** Workers em paralelo; cada um recebe e processa uma mensagem por vez. */
  readonly concurrency: number;
  /**
   * Long polling do ReceiveMessage, em segundos. No shutdown o poll em curso
   * não é abortado, então este é também o tempo máximo para parar de buscar.
   */
  readonly waitTimeSeconds: number;
  /** Tempo que a mensagem fica invisível enquanto é processada. */
  readonly visibilityTimeoutSeconds: number;
  /**
   * Recebimentos antes de desistir da mensagem. Deve ser igual ao
   * maxReceiveCount da redrive policy da fila.
   */
  readonly maxAttempts: number;
  /** Primeiro atraso do backoff de retry (dobra a cada tentativa). */
  readonly retryBaseDelaySeconds: number;
  /** Prazo, no shutdown, para as mensagens em andamento terminarem. */
  readonly shutdownGraceMs: number;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class MissingEnvError extends Error {
  constructor(public readonly variable: string) {
    super(`Variável de ambiente obrigatória ausente: ${variable}`);
    this.name = 'MissingEnvError';
  }
}

export function requireEnv(name: string, source: EnvSource = process.env): string {
  const value = source[name]?.trim();
  if (value === undefined || value === '') {
    throw new MissingEnvError(name);
  }
  return value;
}

function optionalEnv(name: string, source: EnvSource): string | undefined {
  const value = source[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function parsePositiveInt(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} inválida: "${raw}" (esperado inteiro positivo)`);
  }
  return value;
}

/** Um SendMessageBatch leva no máximo 10 mensagens. */
function parseBatchSize(name: string, raw: string): number {
  const value = parsePositiveInt(name, raw);
  if (value > 10) {
    throw new Error(`${name} inválida: "${raw}" (máximo 10, o limite de um SendMessageBatch)`);
  }
  return value;
}

function parseBoolean(name: string, raw: string): boolean {
  if (raw === 'true' || raw === 'false') {
    return raw === 'true';
  }
  throw new Error(`${name} inválida: "${raw}" (esperado true ou false)`);
}

function parseLogLevel(raw: string): LogLevel {
  if ((LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  throw new Error(`LOG_LEVEL inválido: "${raw}" (esperado ${LOG_LEVELS.join(', ')})`);
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT inválida: "${raw}"`);
  }
  return port;
}

export function loadEnv(source: EnvSource = process.env): Env {
  const env = readEnv(source);
  // Uma mensagem pode ficar esperando o lock da wallet por até DB_LOCK_TIMEOUT_MS.
  // Se a visibilidade vencer antes, o SQS a entrega de novo com a primeira
  // entrega ainda em andamento: trabalho duplicado e tentativas gastas à toa.
  if (env.consumer.visibilityTimeoutSeconds * 1000 <= env.databaseLockTimeoutMs) {
    throw new Error(
      `SQS_VISIBILITY_TIMEOUT_SECONDS (${env.consumer.visibilityTimeoutSeconds}s) deve ser maior que ` +
        `DB_LOCK_TIMEOUT_MS (${env.databaseLockTimeoutMs}ms)`,
    );
  }
  return env;
}

function readEnv(source: EnvSource): Env {
  const positive = (name: string, fallback: string) =>
    parsePositiveInt(name, optionalEnv(name, source) ?? fallback);

  return {
    port: parsePort(optionalEnv('PORT', source) ?? '3000'),
    logLevel: parseLogLevel(optionalEnv('LOG_LEVEL', source) ?? 'info'),
    databaseUrl: requireEnv('DATABASE_URL', source),
    databasePoolMax: parsePositiveInt('DB_POOL_MAX', optionalEnv('DB_POOL_MAX', source) ?? '10'),
    databaseLockTimeoutMs: parsePositiveInt(
      'DB_LOCK_TIMEOUT_MS',
      optionalEnv('DB_LOCK_TIMEOUT_MS', source) ?? '5000',
    ),
    awsRegion: requireEnv('AWS_REGION', source),
    sqsEndpoint: optionalEnv('SQS_ENDPOINT', source),
    wagerQueueUrl: requireEnv('SQS_WAGER_QUEUE_URL', source),
    wagerDlqUrl: requireEnv('SQS_WAGER_DLQ_URL', source),
    eventsQueueUrl: requireEnv('SQS_EVENTS_QUEUE_URL', source),
    consumer: {
      enabled: parseBoolean('SQS_CONSUMER_ENABLED', optionalEnv('SQS_CONSUMER_ENABLED', source) ?? 'true'),
      concurrency: positive('SQS_CONSUMER_CONCURRENCY', '5'),
      waitTimeSeconds: positive('SQS_WAIT_TIME_SECONDS', '10'),
      visibilityTimeoutSeconds: positive('SQS_VISIBILITY_TIMEOUT_SECONDS', '30'),
      maxAttempts: positive('SQS_MAX_ATTEMPTS', '5'),
      retryBaseDelaySeconds: positive('SQS_RETRY_BASE_DELAY_SECONDS', '2'),
      shutdownGraceMs: positive('SQS_SHUTDOWN_GRACE_MS', '20000'),
    },
    outbox: {
      enabled: parseBoolean('OUTBOX_PUBLISHER_ENABLED', optionalEnv('OUTBOX_PUBLISHER_ENABLED', source) ?? 'true'),
      pollIntervalMs: positive('OUTBOX_POLL_INTERVAL_MS', '500'),
      batchSize: parseBatchSize('OUTBOX_BATCH_SIZE', optionalEnv('OUTBOX_BATCH_SIZE', source) ?? '10'),
      retryBaseDelayMs: positive('OUTBOX_RETRY_BASE_DELAY_MS', '1000'),
      retryMaxDelayMs: positive('OUTBOX_RETRY_MAX_DELAY_MS', '60000'),
      sendTimeoutMs: positive('OUTBOX_SEND_TIMEOUT_MS', '5000'),
    },
    pendingReference: {
      enabled: parseBoolean(
        'PENDING_REFERENCE_WORKER_ENABLED',
        optionalEnv('PENDING_REFERENCE_WORKER_ENABLED', source) ?? 'true',
      ),
      pollIntervalMs: positive('PENDING_REFERENCE_POLL_INTERVAL_MS', '1000'),
      batchSize: positive('PENDING_REFERENCE_BATCH_SIZE', '20'),
      retryBaseDelayMs: positive('PENDING_REFERENCE_RETRY_BASE_DELAY_MS', '5000'),
      retryMaxDelayMs: positive('PENDING_REFERENCE_RETRY_MAX_DELAY_MS', '300000'),
      maxAttempts: positive('PENDING_REFERENCE_MAX_ATTEMPTS', '8'),
    },
  };
}

/** Token de injeção do `Env` já validado. */
export const ENV = Symbol('ENV');
