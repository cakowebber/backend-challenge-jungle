import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { CLOCK } from '../../src/application/ports/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '../../src/application/ports/event-publisher';
import { METRICS, MetricName } from '../../src/application/ports/observability';
import { OUTBOX_REPOSITORY, type OutboxRepository } from '../../src/application/ports/repositories';
import { UNIT_OF_WORK } from '../../src/application/ports/unit-of-work';
import { OUTBOX_PUBLISH_SETTINGS, PublishOutboxBatch } from '../../src/application/publish-outbox-batch';
import type { OutboxMessage } from '../../src/domain/outbox-message';
import { loadEnv } from '../../src/infrastructure/config/env';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { SQS_CLIENT } from '../../src/infrastructure/messaging/sqs.provider';
import { startTestApp, type TestApp } from '../support/test-app';
import { eventually, TestQueues } from '../support/test-queues';

/**
 * Outbox publisher contra Postgres e LocalStack REAIS. Os publishers dos
 * testes usam o banco e o SQS de verdade; o que os testes acrescentam em volta
 * são só contadores e pontos de falha, para observar o que foi enviado (a
 * deduplicação da fila FIFO esconderia um envio duplicado) e para simular a
 * morte do processo no meio do ciclo.
 */

const BATCH_SIZE = 10;
const RETRY_BASE_DELAY_MS = 300;

let app: TestApp;
let queues: TestQueues;

beforeAll(async () => {
  queues = await TestQueues.create('outbox', 5);
  app = await startTestApp('outbox_publisher', {
    eventsQueueUrl: queues.eventsUrl,
    outbox: {
      ...loadEnv().outbox,
      enabled: false, // os testes disparam os ciclos na mão; um deles liga o worker
      pollIntervalMs: 50,
      batchSize: BATCH_SIZE,
      retryBaseDelayMs: RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: 2_000,
    },
  });
});

beforeEach(async () => {
  // Cada teste começa sem pendências de testes anteriores e com a fila vazia.
  await app.sql`UPDATE outbox_messages SET published_at = now(), next_attempt_at = NULL WHERE published_at IS NULL`;
  await queues.drain(queues.eventsUrl, 0);
});

afterAll(async () => {
  await app.close();
  await queues.destroy();
});

// ---- apoio

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
}

/** Pendentes na ordem em que o publisher as pega. */
async function pendingRows(): Promise<OutboxRow[]> {
  const rows = await app.sql`
    SELECT id, aggregate_id, event_type, attempts, next_attempt_at, published_at
      FROM outbox_messages WHERE published_at IS NULL ORDER BY occurred_at, id`;
  return [...rows] as OutboxRow[];
}

async function rowsById(ids: readonly string[]): Promise<OutboxRow[]> {
  const rows = await app.sql`
    SELECT id, aggregate_id, event_type, attempts, next_attempt_at, published_at
      FROM outbox_messages WHERE id IN ${app.sql([...ids])} ORDER BY occurred_at, id`;
  return [...rows] as OutboxRow[];
}

/** Gera eventos pelo caminho real: cada aposta aprovada grava 2 eventos na outbox. */
async function placeBets(count: number): Promise<void> {
  const wallet = await app.createWallet('1000.00');
  await app.sql`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND aggregate_id IN (
    SELECT ${wallet.id}::uuid UNION SELECT id FROM wager_transactions WHERE wallet_id = ${wallet.id})`; // descarta os eventos da abertura
  const responses = await Promise.all(
    Array.from({ length: count }, () => app.submit(app.payload(wallet, 'BET', '1.00'))),
  );
  expect(responses.map((response) => response.status)).toEqual(Array(count).fill(201));
}

/** Conta os envios por eventId e repassa ao publisher real. */
function counting(inner: EventPublisher, sends: Map<string, number>, beforeSend?: () => Promise<void>): EventPublisher {
  return {
    async publish(messages: readonly OutboxMessage[]) {
      for (const message of messages) {
        sends.set(message.id, (sends.get(message.id) ?? 0) + 1);
      }
      await beforeSend?.();
      return inner.publish(messages);
    },
  };
}

/** Um publisher montado com as portas reais de uma instância, trocando só o que o teste precisa observar. */
function publisherOf(
  instance: TestApp,
  parts: { publisher?: EventPublisher; outbox?: OutboxRepository } = {},
): PublishOutboxBatch {
  return new PublishOutboxBatch(
    instance.app.get(UNIT_OF_WORK),
    parts.outbox ?? instance.app.get(OUTBOX_REPOSITORY),
    parts.publisher ?? instance.app.get(EVENT_PUBLISHER),
    instance.app.get(CLOCK),
    instance.app.get(METRICS),
    instance.app.get(OUTBOX_PUBLISH_SETTINGS),
  );
}

/** Roda ciclos até não haver mais nada vencido. Devolve quantas mensagens este publisher publicou. */
async function runUntilIdle(publisher: PublishOutboxBatch): Promise<number> {
  let published = 0;
  for (;;) {
    const result = await publisher.execute();
    published += result.published;
    if (result.claimed === 0) {
      return published;
    }
  }
}

/** Lê e remove tudo da fila de eventos, devolvendo os envelopes. */
async function publishedEvents() {
  const messages = await queues.drain(queues.eventsUrl, 1);
  return messages.map((message) => ({
    envelope: JSON.parse(message.Body as string) as {
      eventId: string;
      eventType: string;
      aggregateId: string;
      correlationId: string;
      occurredAt: string;
      version: number;
      data: Record<string, unknown>;
    },
    groupId: message.Attributes?.MessageGroupId,
    deduplicationId: message.Attributes?.MessageDeduplicationId,
    eventTypeAttribute: message.MessageAttributes?.eventType?.StringValue,
  }));
}

// ---- testes

describe('publicação', () => {
  test('publica o envelope do evento na fila e marca a linha como publicada', async () => {
    const wallet = await app.createWallet('100.00');
    await app.sql`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`;
    const bet = await app.submit(app.payload(wallet, 'BET', '25.00'));
    const pending = await pendingRows();
    expect(pending.map((row) => row.event_type).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);

    const result = await publisherOf(app).execute();

    expect(result).toEqual({ claimed: 2, published: 2, failed: 0 });
    const events = await publishedEvents();
    expect(events.map((event) => event.envelope.eventId).sort()).toEqual(pending.map((row) => row.id).sort());
    for (const event of events) {
      // O id de deduplicação e o grupo saem do próprio evento.
      expect(event.deduplicationId).toBe(event.envelope.eventId);
      expect(event.groupId).toBe(event.envelope.aggregateId);
      expect(event.eventTypeAttribute).toBe(event.envelope.eventType);
      expect(event.envelope.version).toBe(1);
      expect(typeof event.envelope.correlationId).toBe('string');
    }
    const processed = events.find((event) => event.envelope.eventType === 'WagerTransactionProcessed');
    expect(processed?.envelope.aggregateId).toBe(bet.body.transactionId);
    const balanceChanged = events.find((event) => event.envelope.eventType === 'WalletBalanceChanged');
    expect(balanceChanged?.envelope.aggregateId).toBe(wallet.id);
    expect(balanceChanged?.envelope.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' }); // dinheiro como string

    const stored = await rowsById(pending.map((row) => row.id));
    expect(stored.every((row) => row.published_at !== null && row.attempts === 0)).toBe(true);
    expect(await pendingRows()).toEqual([]);
    expect((await publisherOf(app).execute()).claimed).toBe(0); // publicado não volta a ser selecionado
  });

  test('nada é publicado antes do commit da transação que gravou o evento', async () => {
    const sends = new Map<string, number>();
    const publisher = publisherOf(app, { publisher: counting(app.app.get(EVENT_PUBLISHER), sends) });
    const eventId = Bun.randomUUIDv7();
    const envelope = { eventId, eventType: 'EventoDeTeste', aggregateId: Bun.randomUUIDv7(), version: 1, data: {} };

    await app.sql.begin(async (tx) => {
      await tx`
        INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
        VALUES (${eventId}, ${envelope.aggregateId}, ${envelope.eventType}, ${JSON.stringify(envelope)}::jsonb, now())`;

      // A transação de negócio ainda está aberta: o publisher não enxerga o evento.
      expect(await publisher.execute()).toEqual({ claimed: 0, published: 0, failed: 0 });
      expect(sends.size).toBe(0);
    }); // COMMIT

    expect(await publisher.execute()).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(sends.get(eventId)).toBe(1);
  });
});

describe('vários publishers sobre a mesma outbox', () => {
  test('duas instâncias drenando juntas: cada evento é enviado exatamente uma vez', async () => {
    await placeBets(100); // 200 eventos
    const pending = await pendingRows();
    expect(pending).toHaveLength(200);

    const other = await app.startSibling(); // segunda instância, pool de conexões próprio
    try {
      const sends = new Map<string, number>();
      const overlap = () => Bun.sleep(5); // mantém cada lote travado um instante, para os ciclos se cruzarem
      const first = publisherOf(app, { publisher: counting(app.app.get(EVENT_PUBLISHER), sends, overlap) });
      const second = publisherOf(other, { publisher: counting(other.app.get(EVENT_PUBLISHER), sends, overlap) });

      const [byFirst, bySecond] = await Promise.all([runUntilIdle(first), runUntilIdle(second)]);

      // Os dois trabalharam, e a soma fecha: nenhum evento perdido, nenhum repetido.
      expect(byFirst).toBeGreaterThan(0);
      expect(bySecond).toBeGreaterThan(0);
      expect(byFirst + bySecond).toBe(200);
      expect(sends.size).toBe(200);
      expect([...sends.values()].every((count) => count === 1)).toBe(true);

      expect(await pendingRows()).toEqual([]);
      const stored = await rowsById(pending.map((row) => row.id));
      expect(stored.every((row) => row.published_at !== null && row.attempts === 0)).toBe(true);

      const eventIds = (await publishedEvents()).map((event) => event.envelope.eventId);
      expect(eventIds).toHaveLength(200);
      expect(new Set(eventIds)).toEqual(new Set(pending.map((row) => row.id)));
    } finally {
      await other.close();
    }
  }, 60_000);

  test('SKIP LOCKED: com um lote travado por um publisher, o outro pega o lote seguinte sem esperar', async () => {
    await placeBets(15); // 30 eventos = 3 lotes
    const ordered = (await pendingRows()).map((row) => row.id);
    const other = await app.startSibling();

    // O primeiro publisher trava o lote e fica parado no meio do envio.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const firstBatch = new Map<string, number>();
    let entered!: () => void;
    const sending = new Promise<void>((resolve) => (entered = resolve));
    const first = publisherOf(app, {
      publisher: counting(app.app.get(EVENT_PUBLISHER), firstBatch, async () => {
        entered();
        await held;
      }),
    });

    try {
      const firstRun = first.execute();
      await sending; // o lote 1 está travado no banco agora

      const secondBatch = new Map<string, number>();
      const second = publisherOf(other, { publisher: counting(other.app.get(EVENT_PUBLISHER), secondBatch) });
      const startedAt = Date.now();
      const secondResult = await second.execute();

      // Não esperou o lock (que estouraria em lock_timeout): pulou as linhas travadas.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(secondResult).toEqual({ claimed: BATCH_SIZE, published: BATCH_SIZE, failed: 0 });
      expect([...firstBatch.keys()]).toEqual(ordered.slice(0, BATCH_SIZE));
      expect([...secondBatch.keys()]).toEqual(ordered.slice(BATCH_SIZE, 2 * BATCH_SIZE));

      release();
      expect(await firstRun).toEqual({ claimed: BATCH_SIZE, published: BATCH_SIZE, failed: 0 });
      expect((await pendingRows()).map((row) => row.id)).toEqual(ordered.slice(2 * BATCH_SIZE));
    } finally {
      release();
      await other.close();
    }
  });
});

describe('falhas', () => {
  test('processo morre entre publicar no SQS e marcar: o evento é republicado com o mesmo id e a fila fica com uma cópia', async () => {
    await placeBets(2); // 4 eventos
    const ids = (await pendingRows()).map((row) => row.id);
    const sends = new Map<string, number>();

    // O envio ao SQS acontece de verdade; a "morte" é a transação do publisher
    // nunca commitar a marcação — o que o Postgres faz quando a conexão cai.
    const real = app.app.get<OutboxRepository>(OUTBOX_REPOSITORY);
    const diesBeforeMarking: OutboxRepository = {
      add: (messages) => real.add(messages),
      lockDueBatch: (now, limit) => real.lockDueBatch(now, limit),
      saveRetry: (message) => real.saveRetry(message),
      markPublished: () => Promise.reject(new Error('processo morreu antes de marcar')),
    };
    const dying = publisherOf(app, {
      outbox: diesBeforeMarking,
      publisher: counting(app.app.get(EVENT_PUBLISHER), sends),
    });

    await expect(dying.execute()).rejects.toThrow('processo morreu antes de marcar');

    // O SQS já tem as mensagens, mas o banco não registrou nada: rollback.
    expect(await queues.depth(queues.eventsUrl)).toBe(4);
    const afterCrash = await pendingRows();
    expect(afterCrash.map((row) => row.id)).toEqual(ids);
    expect(afterCrash.every((row) => row.attempts === 0 && row.next_attempt_at === null)).toBe(true);

    // Outra instância assume e publica de novo — os MESMOS eventIds.
    const other = await app.startSibling();
    try {
      const survivor = publisherOf(other, { publisher: counting(other.app.get(EVENT_PUBLISHER), sends) });
      expect(await survivor.execute()).toEqual({ claimed: 4, published: 4, failed: 0 });
    } finally {
      await other.close();
    }

    expect(ids.map((id) => sends.get(id))).toEqual([2, 2, 2, 2]); // enviado duas vezes...
    expect(await pendingRows()).toEqual([]);
    const delivered = (await publishedEvents()).map((event) => event.envelope.eventId);
    expect(delivered.sort()).toEqual([...ids].sort()); // ...e a fila FIFO descartou a segunda cópia pelo eventId
  });

  test('SQS recusando: conta a tentativa, espera o backoff e publica quando o destino volta', async () => {
    await placeBets(1); // 2 eventos
    const ids = (await pendingRows()).map((row) => row.id);
    const metrics = app.metrics;
    const failuresBefore = metrics.value(MetricName.OutboxPublishFailures);

    const unreachable = new SqsEventPublisher(
      app.app.get(SQS_CLIENT),
      queues.eventsUrl.replace('-events.fifo', '-nao-existe.fifo'),
      2_000,
    );
    const failing = publisherOf(app, { publisher: unreachable });
    const healthy = publisherOf(app);

    // 1ª falha: a transação do publisher COMMITA o backoff (não é rollback).
    const before = Date.now();
    expect(await failing.execute()).toEqual({ claimed: 2, published: 0, failed: 2 });
    let rows = await rowsById(ids);
    expect(rows.map((row) => row.attempts)).toEqual([1, 1]);
    expect(rows.every((row) => row.published_at === null)).toBe(true);
    for (const row of rows) {
      expect((row.next_attempt_at as Date).getTime()).toBeGreaterThanOrEqual(before + RETRY_BASE_DELAY_MS);
    }
    expect(metrics.value(MetricName.OutboxPublishFailures)).toBe(failuresBefore + 2);

    // Dentro do backoff ninguém pega a mensagem, nem um publisher saudável.
    expect((await healthy.execute()).claimed).toBe(0);

    // 2ª falha: o atraso dobra.
    await Bun.sleep(RETRY_BASE_DELAY_MS + 50);
    const beforeSecond = Date.now();
    expect(await failing.execute()).toEqual({ claimed: 2, published: 0, failed: 2 });
    rows = await rowsById(ids);
    expect(rows.map((row) => row.attempts)).toEqual([2, 2]);
    for (const row of rows) {
      expect((row.next_attempt_at as Date).getTime()).toBeGreaterThanOrEqual(beforeSecond + 2 * RETRY_BASE_DELAY_MS);
    }

    // O destino voltou: vencido o backoff, publica. Evento confirmado não se perde.
    await Bun.sleep(2 * RETRY_BASE_DELAY_MS + 50);
    expect(await healthy.execute()).toEqual({ claimed: 2, published: 2, failed: 0 });
    rows = await rowsById(ids);
    expect(rows.every((row) => row.published_at !== null && row.next_attempt_at === null)).toBe(true);
    expect((await publishedEvents()).map((event) => event.envelope.eventId).sort()).toEqual([...ids].sort());
  });
});

describe('worker em segundo plano', () => {
  test('instância commita e morre antes de publicar: outra instância, com o worker ligado, publica', async () => {
    // `app` está com o publisher desligado: commita e nunca publica, como um processo que morreu logo após o commit.
    const wallet = await app.createWallet('100.00');
    const bet = await app.submit(app.payload(wallet, 'BET', '10.00'));
    expect(bet.status).toBe(201);
    const ids = (await pendingRows()).map((row) => row.id);
    expect(ids).toHaveLength(4); // abertura (2) + aposta (2)
    expect(await queues.depth(queues.eventsUrl)).toBe(0);

    const other = await app.startSibling({ outbox: { ...app.env.outbox, enabled: true } });
    try {
      await eventually('a outra instância publicar os eventos pendentes', async () => (await pendingRows()).length === 0);
    } finally {
      await other.close(); // para o worker: o que vier depois fica pendente
    }

    expect((await publishedEvents()).map((event) => event.envelope.eventId).sort()).toEqual([...ids].sort());

    await app.submit(app.payload(wallet, 'BET', '10.00'));
    await Bun.sleep(300); // vários intervalos de poll
    expect(await pendingRows()).toHaveLength(2);
  });
});
