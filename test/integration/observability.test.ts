import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { PublishOutboxBatch } from '../../src/application/publish-outbox-batch';
import { GaugeName, METRIC_CATALOG } from '../../src/infrastructure/observability/metric-catalog';
import { Cluster } from '../support/cluster';
import { startTestApp, type TestApp } from '../support/test-app';
import { eventually, TestQueues } from '../support/test-queues';

setDefaultTimeout(30_000);

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parseMetrics(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([a-z_]+)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (match === null) {
      throw new Error(`linha fora do formato do Prometheus: ${line}`);
    }
    const labels: Record<string, string> = {};
    for (const [, label, value] of (match[2] ?? '').matchAll(/([a-z_]+)="((?:[^"\\]|\\.)*)"/g)) {
      labels[label as string] = value as string;
    }
    samples.push({ name: match[1] as string, labels, value: Number(match[3]) });
  }
  return samples;
}

function valueOf(samples: Sample[], name: string, labels: Record<string, string> = {}): number | undefined {
  const matching = samples.filter(
    (sample) => sample.name === name && Object.entries(labels).every(([label, value]) => sample.labels[label] === value),
  );
  return matching.length === 0 ? undefined : matching.reduce((total, sample) => total + sample.value, 0);
}

describe('GET /metrics', () => {
  let app: TestApp;
  let queues: TestQueues;

  async function scrapeText(target: TestApp = app): Promise<string> {
    const response = await fetch(`${target.baseUrl}/metrics`);
    expect(response.status).toBe(200);
    return response.text();
  }

  async function scrape(target: TestApp = app): Promise<Sample[]> {
    return parseMetrics(await scrapeText(target));
  }

  function delta(before: Sample[], after: Sample[], name: string, labels: Record<string, string> = {}): number {
    return (valueOf(after, name, labels) ?? 0) - (valueOf(before, name, labels) ?? 0);
  }

  async function holdWalletLock(walletId: string): Promise<{ release: () => Promise<void> }> {
    let free!: () => void;
    const freed = new Promise<void>((resolve) => (free = resolve));
    let taken!: () => void;
    const lockTaken = new Promise<void>((resolve) => (taken = resolve));
    const holder = app.sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;
      taken();
      await freed;
    });
    await lockTaken;
    return {
      release: async () => {
        free();
        await holder;
      },
    };
  }

  async function publishOutbox(): Promise<number> {
    const publisher = app.app.get(PublishOutboxBatch);
    let published = 0;
    for (;;) {
      const result = await publisher.execute();
      published += result.published;
      if (result.claimed === 0) {
        return published;
      }
    }
  }

  beforeAll(async () => {
    queues = await TestQueues.create('observability', 3);
    app = await startTestApp('observability', {
      wagerQueueUrl: queues.queueUrl,
      wagerDlqUrl: queues.dlqUrl,
      eventsQueueUrl: queues.eventsUrl,
      databaseLockTimeoutMs: 300,
      consumer: {
        enabled: true,
        concurrency: 2,
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: 10,
        maxAttempts: 3,
        retryBaseDelaySeconds: 1,
        shutdownGraceMs: 5_000,
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await queues.destroy();
  });

  test('formato texto do Prometheus, com cabeçalho HELP e TYPE para tudo que está no catálogo', async () => {
    const response = await fetch(`${app.baseUrl}/metrics`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(() => parseMetrics(text)).not.toThrow();
    for (const [name, definition] of Object.entries(METRIC_CATALOG)) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} ${definition.type}\n`);
    }
  });

  test('transações por status, duplicatas detectadas e latência de processamento', async () => {
    const wallet = await app.createWallet('100.00');
    const before = await scrape();

    const approved = app.payload(wallet, 'BET', '30.00');
    expect((await app.submit(approved)).status).toBe(201);
    expect((await app.submit(app.payload(wallet, 'BET', '500.00'))).status).toBe(422);
    expect((await app.submit(approved)).body.idempotentReplay).toBe(true);

    const text = await scrapeText();
    const after = parseMetrics(text);
    expect(delta(before, after, 'wager_transactions_total', { status: 'PROCESSED' })).toBe(1);
    expect(delta(before, after, 'wager_transactions_total', { status: 'REJECTED' })).toBe(1);
    expect(delta(before, after, 'wager_duplicates_detected_total')).toBe(1);

    const duration = 'wager_transaction_duration_seconds_count';
    expect(delta(before, after, duration, { source: 'http', outcome: 'PROCESSED' })).toBe(1);
    expect(delta(before, after, duration, { source: 'http', outcome: 'REJECTED' })).toBe(1);
    expect(delta(before, after, duration, { source: 'http', outcome: 'DUPLICATE' })).toBe(1);
    expect(valueOf(after, 'wager_transaction_duration_seconds_bucket', { le: '+Inf' })).toBe(valueOf(after, duration));
    expect(valueOf(after, 'wager_transaction_duration_seconds_sum')).toBeGreaterThan(0);

    expect(text).not.toContain(wallet.id);
    expect(text).not.toContain('provider-a');
  });

  test('latência HTTP usa o padrão da rota como label, nunca a URL', async () => {
    const wallet = await app.createWallet('10.00');
    const before = await scrape();

    expect((await app.get(`/wallets/${wallet.id}`)).status).toBe(200);
    expect((await app.get('/rota-que-nao-existe/123')).status).toBe(404);

    const text = await scrapeText();
    const after = parseMetrics(text);
    const requests = 'http_request_duration_seconds_count';
    expect(delta(before, after, requests, { method: 'GET', route: '/wallets/:walletId', status: '200' })).toBe(1);
    expect(delta(before, after, requests, { method: 'GET', route: 'unmatched', status: '404' })).toBe(1);
    expect(text).not.toContain('rota-que-nao-existe');
  });

  test('conflito de lock: espera que estoura o lock_timeout é contada', async () => {
    const wallet = await app.createWallet('100.00');
    const before = await scrape();
    const lock = await holdWalletLock(wallet.id);

    const blocked = await app.submit(app.payload(wallet, 'BET', '10.00'));
    await lock.release();

    expect(blocked.status).toBe(503);
    const after = await scrape();
    expect(delta(before, after, 'wager_lock_conflicts_total', { reason: 'LOCK_TIMEOUT' })).toBe(1);
    expect(
      delta(before, after, 'wager_transaction_duration_seconds_count', { source: 'http', outcome: 'TRANSIENT_FAILURE' }),
    ).toBe(1);
    expect(delta(before, after, 'wallet_lock_wait_seconds_count')).toBe(1);
    expect(delta(before, after, 'wallet_lock_wait_seconds_bucket', { le: '0.1' })).toBe(0);
  });

  test('outbox lag: cresce enquanto há evento sem publicar e volta a zero depois da publicação', async () => {
    await publishOutbox();
    const drained = await scrape();
    expect(valueOf(drained, GaugeName.OutboxPending)).toBe(0);
    expect(valueOf(drained, GaugeName.OutboxLag)).toBe(0);

    const wallet = await app.createWallet('100.00');
    await app.submit(app.payload(wallet, 'BET', '10.00'));
    const [row] = await app.sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
    const pending = row.n as number;
    expect(pending).toBeGreaterThan(0);
    await Bun.sleep(1_100);

    const lagging = await scrape();
    expect(valueOf(lagging, GaugeName.OutboxPending)).toBe(pending);
    expect(valueOf(lagging, GaugeName.OutboxLag)).toBeGreaterThanOrEqual(1);

    expect(await publishOutbox()).toBe(pending);

    const published = await scrape();
    expect(valueOf(published, GaugeName.OutboxPending)).toBe(0);
    expect(valueOf(published, GaugeName.OutboxLag)).toBe(0);
    expect(delta(lagging, published, 'outbox_events_published_total')).toBe(pending);
    expect(delta(lagging, published, 'outbox_publish_delay_seconds_count')).toBe(pending);
    expect(delta(lagging, published, 'outbox_publish_delay_seconds_bucket', { le: '1' })).toBe(0);
  });

  test('PENDING_REFERENCE: o estorno que espera a referência aparece no contador e no gauge', async () => {
    const wallet = await app.createWallet('100.00');
    const before = await scrape();

    const refund = app.payload(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: 'bet-que-ainda-nao-chegou' });
    expect((await app.submit(refund)).status).toBe(202);

    const after = await scrape();
    expect(delta(before, after, 'wager_transactions_total', { status: 'PENDING_REFERENCE' })).toBe(1);
    expect(delta(before, after, GaugeName.PendingReferences)).toBe(1);
  });

  test('retries: mensagem que não consegue o lock volta para a fila e é contada', async () => {
    const wallet = await app.createWallet('100.00');
    const before = await scrape();
    const lock = await holdWalletLock(wallet.id);

    const payload = app.payload(wallet, 'BET', '10.00');
    await queues.send(payload);
    await eventually('mensagem devolvida para nova tentativa', async () => {
      return delta(before, await scrape(), 'wager_message_retries_total', { reason: 'LOCK_TIMEOUT' }) >= 1;
    });
    await lock.release();

    await eventually('mensagem processada na nova tentativa', async () => (await app.balanceOf(wallet.id)) === '90.00');
    await eventually('fila vazia', async () => (await queues.depth(queues.queueUrl)) === 0);
    const after = await scrape();
    expect(delta(before, after, 'wager_messages_total', { outcome: 'RETRY' })).toBeGreaterThanOrEqual(1);
    expect(delta(before, after, 'wager_messages_total', { outcome: 'PROCESSED' })).toBe(1);
    expect(delta(before, after, 'wager_transaction_duration_seconds_count', { source: 'sqs', outcome: 'PROCESSED' })).toBe(1);
    expect(valueOf(after, GaugeName.QueueMessages, { state: 'visible' })).toBe(0);
    expect(valueOf(after, GaugeName.QueueMessages, { state: 'in_flight' })).toBe(0);
  });

  test('mensagens em DLQ: o contador diz o motivo e o gauge diz quantas estão lá agora', async () => {
    const before = await scrape();
    expect(valueOf(before, GaugeName.DlqMessages)).toBe(0);

    await queues.sendRaw('isto não é JSON');
    await eventually('mensagem na DLQ', async () => (await queues.depth(queues.dlqUrl)) === 1);
    await eventually('mensagem apagada da fila de entrada', async () => (await queues.depth(queues.queueUrl)) === 0);

    const after = await scrape();
    expect(delta(before, after, 'wager_messages_dead_lettered_total', { reason: 'INVALID_MESSAGE' })).toBe(1);
    expect(valueOf(after, GaugeName.DlqMessages)).toBe(1);

    await queues.drain(queues.dlqUrl);
    const emptied = await scrape();
    expect(valueOf(emptied, GaugeName.DlqMessages)).toBe(0);
    expect(delta(before, emptied, 'wager_messages_dead_lettered_total', { reason: 'INVALID_MESSAGE' })).toBe(1);
  });

  test('SQS inalcançável não derruba o /metrics: os gauges da fila somem e o erro de coleta é contado', async () => {
    const sibling = await app.startSibling({
      wagerDlqUrl: `${queues.dlqUrl}-inexistente`,
      consumer: { ...app.env.consumer, enabled: false },
    });
    try {
      const samples = await scrape(sibling);

      expect(valueOf(samples, 'metrics_collection_errors_total', { source: 'sqs' })).toBe(1);
      expect(valueOf(samples, GaugeName.DlqMessages)).toBeUndefined();
      expect(valueOf(samples, GaugeName.QueueMessages)).toBeUndefined();
      expect(valueOf(samples, GaugeName.OutboxPending)).toBeNumber();
      expect(valueOf(samples, 'wager_duplicates_detected_total')).toBe(0);
    } finally {
      await sibling.close();
    }
  });

  test('X-Correlation-Id volta em toda resposta, inclusive nas de erro', async () => {
    const echoed = await app.post('/wagering/transactions', { kind: 'BET' }, { 'x-correlation-id': 'corr-do-provedor' });
    expect(echoed.status).toBe(400);
    expect(echoed.headers.get('x-correlation-id')).toBe('corr-do-provedor');

    const generated = await app.get('/wallets/nao-e-um-uuid');
    expect(generated.status).toBe(400);
    expect(generated.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);

    const malformed = await app.request('POST', '/wagering/transactions', {
      body: '{"kind": ',
      headers: { 'x-correlation-id': 'corr-json-malformado' },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('x-correlation-id')).toBe('corr-json-malformado');
  });
});

describe('logs de um processo real', () => {
  let cluster: Cluster;

  interface LogEntry {
    timestamp: string;
    level: string;
    message: string;
    [field: string]: unknown;
  }

  const entries = (): LogEntry[] => (cluster.nodes[0]?.output ?? []).map((line) => JSON.parse(line) as LogEntry);
  const entry = (message: string, fields: Record<string, unknown>) =>
    entries().find(
      (candidate) =>
        candidate.message === message && Object.entries(fields).every(([name, value]) => candidate[name] === value),
    );

  beforeAll(async () => {
    cluster = await Cluster.start(
      'observability_logs',
      1,
      { SQS_WAIT_TIME_SECONDS: '1', SQS_MAX_ATTEMPTS: '3', OUTBOX_POLL_INTERVAL_MS: '100' },
      { captureOutput: true },
    );
  });

  afterAll(async () => {
    await cluster.stop();
  });

  test('toda linha é JSON com os ids de rastreio no nível raiz, e nenhum valor financeiro', async () => {
    const [client] = cluster.clients;
    if (client === undefined) throw new Error('cluster sem instância');
    const amounts = { initial: '4321.07', http: '37.91', queue: '12.34', rejected: '999999.99' };
    const wallet = await client.createWallet(amounts.initial);

    const viaHttp = client.payload(wallet, 'BET', amounts.http);
    const approved = await client.post('/wagering/transactions', viaHttp, {
      'idempotency-key': `provider-a:${viaHttp.externalTransactionId}`,
      'x-correlation-id': 'corr-log-http',
    });
    expect(approved.status).toBe(201);
    const rejected = await client.submit(client.payload(wallet, 'BET', amounts.rejected));
    expect(rejected.status).toBe(422);
    await client.submit(viaHttp);
    const invalid = await client.post(
      '/wagering/transactions',
      { ...viaHttp, money: { amount: 12.5, currency: 'BRL' } },
      { 'idempotency-key': 'chave-invalida', 'x-correlation-id': 'corr-log-invalido' },
    );
    expect(invalid.status).toBe(400);

    const viaQueue = client.payload(wallet, 'BET', amounts.queue);
    await cluster.queues.send(viaQueue, { messageId: 'msg-log-1' });
    const orphan = client.payload({ ...wallet, id: Bun.randomUUIDv7() }, 'BET', amounts.queue);
    await cluster.queues.send(orphan, { messageId: 'msg-log-sem-wallet' });

    await eventually('logs das duas mensagens da fila', async () => {
      return (
        entry('transação processada', { messageId: 'msg-log-1' }) !== undefined &&
        entry('mensagem rejeitada sem registro enviada para a DLQ', { messageId: 'msg-log-sem-wallet' }) !== undefined
      );
    });

    const lines = cluster.nodes[0]?.output ?? [];
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      const parsed = JSON.parse(line) as LogEntry;
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
      expect(['debug', 'info', 'warn', 'error']).toContain(parsed.level);
      expect(parsed.message).toBeString();
      expect(parsed.service).toBe('wagering-processor');
      expect(parsed.instance).toBeString();
    }
    expect(entries().some((candidate) => candidate.context === 'NestApplication')).toBe(true);

    expect(entry('transação processada', { correlationId: 'corr-log-http' })).toMatchObject({
      level: 'info',
      transactionId: approved.body.transactionId,
      walletId: wallet.id,
      providerId: 'provider-a',
      externalTransactionId: viaHttp.externalTransactionId,
      kind: 'BET',
      status: 'PROCESSED',
      idempotentReplay: false,
      source: 'http',
    });
    expect(entry('transação processada', { correlationId: 'corr-log-http' })).not.toHaveProperty('messageId');
    expect(entry('requisição http', { correlationId: 'corr-log-http' })).toMatchObject({
      method: 'POST',
      route: '/wagering/transactions',
      status: 201,
    });

    expect(entry('transação processada', { transactionId: rejected.body.transactionId })).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      walletId: wallet.id,
    });
    expect(
      entry('transação repetida: resultado original devolvido', { transactionId: approved.body.transactionId }),
    ).toMatchObject({ idempotentReplay: true, status: 'PROCESSED' });
    expect(entry('requisição recusada', { correlationId: 'corr-log-invalido' })).toMatchObject({
      status: 400,
      code: 'INVALID_PAYLOAD',
    });

    expect(entry('transação processada', { messageId: 'msg-log-1' })).toMatchObject({
      correlationId: 'msg-log-1',
      walletId: wallet.id,
      providerId: 'provider-a',
      externalTransactionId: viaQueue.externalTransactionId,
      status: 'PROCESSED',
      source: 'sqs',
    });
    expect(entry('transação processada', { messageId: 'msg-log-1' })?.transactionId).toBeString();
    expect(entry('mensagem rejeitada sem registro enviada para a DLQ', { messageId: 'msg-log-sem-wallet' })).toMatchObject({
      level: 'warn',
      walletId: orphan.walletId,
      providerId: 'provider-a',
      reason: 'WALLET_NOT_FOUND',
    });

    const output = lines.join('\n');
    for (const amount of Object.values(amounts)) {
      expect(output).not.toContain(amount);
    }
    expect(output).not.toMatch(/"(amount|balance|money|payload|body)[A-Za-z]*":/i);
    expect(output).not.toContain(wallet.playerId);
  });

  test('falha ao subir também sai como uma linha JSON, e o processo termina com erro', async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, 'src/main.ts'],
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, LOG_LEVEL: 'barulhento' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe('');
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      level: 'error',
      message: 'falha ao iniciar a aplicação',
      reason: 'LOG_LEVEL inválido: "barulhento" (esperado debug, info, warn, error, silent)',
    });
  });
});
