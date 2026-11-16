import { describe, expect, test } from 'bun:test';
import { OutboxMessage } from '../domain/outbox-message';
import type { EventPublisher } from './ports/event-publisher';
import type { OutboxRepository } from './ports/repositories';
import type { UnitOfWork } from './ports/unit-of-work';
import { PublishOutboxBatch } from './publish-outbox-batch';

/**
 * Decisões do ciclo de publicação, com portas em memória. O comportamento
 * contra Postgres e SQS reais (SKIP LOCKED, queda no meio, vários publishers)
 * está em test/integration/outbox-publisher.test.ts.
 */

const NOW = new Date('2026-11-15T12:00:00.000Z');
const RETRY = { baseDelayMs: 1_000, maxDelayMs: 60_000 };

function pending(id: string, attempts = 0): OutboxMessage {
  return OutboxMessage.rehydrate({
    id,
    aggregateId: `agg-${id}`,
    eventType: 'EventoDeTeste',
    payload: { eventId: id },
    occurredAt: NOW,
    attempts,
    nextAttemptAt: undefined,
    publishedAt: undefined,
  });
}

function setup(batch: OutboxMessage[], publish: EventPublisher['publish']) {
  const marked: { ids: readonly string[]; at: Date }[] = [];
  const retried: OutboxMessage[] = [];
  const counters = new Map<string, number>();
  const requested: number[] = [];
  const observed: { name: string; seconds: number }[] = [];

  const outbox: OutboxRepository = {
    add: async () => undefined,
    lockDueBatch: async (_now, limit) => {
      requested.push(limit);
      return batch;
    },
    markPublished: async (ids, at) => {
      marked.push({ ids, at });
    },
    saveRetry: async (message) => {
      retried.push(message);
    },
  };
  const unitOfWork: UnitOfWork = { transactional: (work) => work(), session: (work) => work() };
  const useCase = new PublishOutboxBatch(
    unitOfWork,
    outbox,
    { publish },
    { now: () => NOW },
    {
      increment: (name, _labels, by = 1) => void counters.set(name, (counters.get(name) ?? 0) + by),
      observe: (name, seconds) => void observed.push({ name, seconds }),
    },
    { batchSize: 10, retry: RETRY },
  );
  return { useCase, marked, retried, counters, requested, observed };
}

describe('PublishOutboxBatch', () => {
  test('sem pendentes: não chama o publisher nem grava nada', async () => {
    let published = false;
    const { useCase, marked, requested } = setup([], async () => {
      published = true;
      return new Map();
    });

    expect(await useCase.execute()).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(published).toBe(false);
    expect(marked).toEqual([]);
    expect(requested).toEqual([10]); // pede ao banco o tamanho de lote configurado
  });

  test('tudo aceito: marca o lote inteiro como publicado', async () => {
    const batch = [pending('a'), pending('b')];
    const { useCase, marked, retried, counters } = setup(batch, async () => new Map());

    expect(await useCase.execute()).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect(marked).toEqual([{ ids: ['a', 'b'], at: NOW }]);
    expect(retried).toEqual([]);
    expect(batch.every((message) => !message.isPending())).toBe(true);
    expect(counters.get('outbox_events_published_total')).toBe(2);
  });

  test('falha parcial: marca só as aceitas e agenda nova tentativa para a recusada', async () => {
    const batch = [pending('a'), pending('b', 2), pending('c')];
    const { useCase, marked, retried, counters, observed } = setup(
      batch,
      async () => new Map([['b', 'InternalError']]),
    );

    expect(await useCase.execute()).toEqual({ claimed: 3, published: 2, failed: 1 });
    // O atraso de publicação só é medido para o que foi de fato publicado.
    expect(observed).toEqual([
      { name: 'outbox_publish_delay_seconds', seconds: 0 },
      { name: 'outbox_publish_delay_seconds', seconds: 0 },
    ]);
    expect(marked).toEqual([{ ids: ['a', 'c'], at: NOW }]);
    expect(retried.map((message) => message.id)).toEqual(['b']);
    // 3ª tentativa frustrada: backoff de 1s * 2^2 = 4s, e a mensagem segue pendente.
    expect(batch[1]?.attempts).toBe(3);
    expect(batch[1]?.nextAttemptAt).toEqual(new Date(NOW.getTime() + 4_000));
    expect(batch[1]?.isPending()).toBe(true);
    expect(counters.get('outbox_publish_failures_total')).toBe(1);
  });

  test('o envio inteiro falha: nada é marcado, todas ganham backoff e o ciclo não lança', async () => {
    const batch = [pending('a'), pending('b')];
    const { useCase, marked, retried } = setup(batch, async () => {
      throw new Error('SQS fora do ar');
    });

    // Não lançar é o que permite a transação commitar o backoff.
    expect(await useCase.execute()).toEqual({ claimed: 2, published: 0, failed: 2 });
    expect(marked).toEqual([{ ids: [], at: NOW }]);
    expect(retried.map((message) => message.id)).toEqual(['a', 'b']);
    expect(batch.map((message) => message.attempts)).toEqual([1, 1]);
    expect(batch[0]?.nextAttemptAt).toEqual(new Date(NOW.getTime() + 1_000));
  });

  test('o backoff tem teto e não há limite de tentativas: a mensagem nunca é descartada', async () => {
    const batch = [pending('a', 500)];
    const { useCase } = setup(batch, async () => new Map([['a', 'x']]));

    await useCase.execute();

    expect(batch[0]?.attempts).toBe(501);
    expect(batch[0]?.nextAttemptAt).toEqual(new Date(NOW.getTime() + RETRY.maxDelayMs));
    expect(batch[0]?.isPending()).toBe(true);
  });
});
