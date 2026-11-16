import { describe, expect, test } from 'bun:test';
import { loadEnv, MissingEnvError } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  AWS_REGION: 'us-east-1',
  SQS_WAGER_QUEUE_URL: 'http://localhost:4566/000000000000/wager-transactions.fifo',
  SQS_WAGER_DLQ_URL: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/wager-events.fifo',
};

describe('loadEnv', () => {
  test('usa a porta 3000 e endpoint SQS indefinido quando não informados', () => {
    const env = loadEnv(valid);

    expect(env.port).toBe(3000);
    expect(env.sqsEndpoint).toBeUndefined();
    expect(env.databaseUrl).toBe(valid.DATABASE_URL);
  });

  test('falha nomeando a variável obrigatória ausente', () => {
    const { DATABASE_URL: _omitida, ...semBanco } = valid;

    expect(() => loadEnv(semBanco)).toThrow(new MissingEnvError('DATABASE_URL'));
  });

  test('trata string vazia como ausente', () => {
    expect(() => loadEnv({ ...valid, AWS_REGION: '  ' })).toThrow(MissingEnvError);
  });

  test('consumer ligado por padrão, com 5 tentativas (igual ao maxReceiveCount da fila)', () => {
    const { consumer } = loadEnv(valid);

    expect(consumer.enabled).toBe(true);
    expect(consumer.maxAttempts).toBe(5);
    expect(loadEnv({ ...valid, SQS_CONSUMER_ENABLED: 'false' }).consumer.enabled).toBe(false);
    expect(() => loadEnv({ ...valid, SQS_CONSUMER_ENABLED: 'sim' })).toThrow('SQS_CONSUMER_ENABLED inválida');
    expect(() => loadEnv({ ...valid, SQS_MAX_ATTEMPTS: '0' })).toThrow('SQS_MAX_ATTEMPTS inválida');
  });

  test('fila de eventos é obrigatória', () => {
    const { SQS_EVENTS_QUEUE_URL: _omitida, ...semFila } = valid;

    expect(() => loadEnv(semFila)).toThrow(new MissingEnvError('SQS_EVENTS_QUEUE_URL'));
  });

  test('outbox publisher: ligado por padrão, lote de no máximo 10 (limite do SendMessageBatch)', () => {
    const { outbox } = loadEnv(valid);

    expect(outbox).toEqual({
      enabled: true,
      pollIntervalMs: 500,
      batchSize: 10,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 60_000,
      sendTimeoutMs: 5_000,
    });
    expect(loadEnv({ ...valid, OUTBOX_BATCH_SIZE: '3' }).outbox.batchSize).toBe(3);
    expect(() => loadEnv({ ...valid, OUTBOX_BATCH_SIZE: '11' })).toThrow('OUTBOX_BATCH_SIZE inválida');
    expect(loadEnv({ ...valid, OUTBOX_PUBLISHER_ENABLED: 'false' }).outbox.enabled).toBe(false);
  });

  test('worker de PENDING_REFERENCE: 5s dobrando até 5 min, 8 tentativas', () => {
    const { pendingReference } = loadEnv(valid);

    expect(pendingReference).toEqual({
      enabled: true,
      pollIntervalMs: 1_000,
      batchSize: 20,
      retryBaseDelayMs: 5_000,
      retryMaxDelayMs: 300_000,
      maxAttempts: 8,
    });
    expect(loadEnv({ ...valid, PENDING_REFERENCE_MAX_ATTEMPTS: '3' }).pendingReference.maxAttempts).toBe(3);
    expect(() => loadEnv({ ...valid, PENDING_REFERENCE_MAX_ATTEMPTS: '0' })).toThrow(
      'PENDING_REFERENCE_MAX_ATTEMPTS inválida',
    );
  });

  test('a visibilidade da mensagem tem que ser maior que a espera máxima por um lock', () => {
    expect(() => loadEnv({ ...valid, SQS_VISIBILITY_TIMEOUT_SECONDS: '5', DB_LOCK_TIMEOUT_MS: '5000' })).toThrow(
      'SQS_VISIBILITY_TIMEOUT_SECONDS (5s) deve ser maior que DB_LOCK_TIMEOUT_MS (5000ms)',
    );
    expect(loadEnv({ ...valid, SQS_VISIBILITY_TIMEOUT_SECONDS: '6', DB_LOCK_TIMEOUT_MS: '5000' }).consumer).toMatchObject({
      visibilityTimeoutSeconds: 6,
    });
  });

  test('nível de log: info por padrão; valor desconhecido impede a subida', () => {
    expect(loadEnv(valid).logLevel).toBe('info');
    expect(loadEnv({ ...valid, LOG_LEVEL: 'warn' }).logLevel).toBe('warn');
    expect(() => loadEnv({ ...valid, LOG_LEVEL: 'barulhento' })).toThrow('LOG_LEVEL');
  });

  test('rejeita porta que não é um inteiro válido', () => {
    expect(() => loadEnv({ ...valid, PORT: '80.5' })).toThrow('PORT inválida');
    expect(() => loadEnv({ ...valid, PORT: 'abc' })).toThrow('PORT inválida');
  });
});
