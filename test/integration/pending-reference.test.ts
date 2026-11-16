import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ApplyWagerTransaction } from '../../src/application/apply-wager-transaction';
import type { Clock } from '../../src/application/ports/clock';
import { ID_GENERATOR } from '../../src/application/ports/id-generator';
import { APP_LOGGER, METRICS } from '../../src/application/ports/observability';
import { WAGER_TRANSACTION_REPOSITORY, WALLET_REPOSITORY } from '../../src/application/ports/repositories';
import { UNIT_OF_WORK } from '../../src/application/ports/unit-of-work';
import { PublishOutboxBatch } from '../../src/application/publish-outbox-batch';
import { RetryPendingReferences } from '../../src/application/retry-pending-references';
import { loadEnv } from '../../src/infrastructure/config/env';
import { startTestApp, type TestApp, type WalletJson } from '../support/test-app';
import { eventually, TestQueues } from '../support/test-queues';

/**
 * REFUND/ROLLBACK que chegam antes da transação referenciada, contra Postgres
 * e LocalStack REAIS.
 *
 * O worker é o código de produção, montado com as portas reais da aplicação.
 * A única coisa trocada é o relógio: em vez de dormir os segundos do backoff,
 * o teste adianta a hora que o worker enxerga. Um bloco no fim roda o worker
 * em segundo plano com o relógio de verdade.
 */

const BASE_DELAY_MS = 10_000;
const MAX_DELAY_MS = 40_000;
const MAX_ATTEMPTS = 3;
const BATCH = 20;

/** Relógio que anda quando o teste manda. */
class TestClock implements Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

let app: TestApp;
let queues: TestQueues;
let clock: TestClock;
let worker: RetryPendingReferences;

function workerOf(instance: TestApp, sharedClock: Clock): RetryPendingReferences {
  return new RetryPendingReferences(
    instance.app.get(UNIT_OF_WORK),
    instance.app.get(WALLET_REPOSITORY),
    instance.app.get(WAGER_TRANSACTION_REPOSITORY),
    instance.app.get(ApplyWagerTransaction),
    instance.app.get(ID_GENERATOR),
    sharedClock,
    instance.app.get(METRICS),
    instance.app.get(APP_LOGGER),
  );
}

beforeAll(async () => {
  queues = await TestQueues.create('pending-ref', 5);
  app = await startTestApp('pending_reference', {
    eventsQueueUrl: queues.eventsUrl,
    pendingReference: {
      enabled: false, // os testes disparam os ciclos na mão
      pollIntervalMs: 50,
      batchSize: BATCH,
      retryBaseDelayMs: BASE_DELAY_MS,
      retryMaxDelayMs: MAX_DELAY_MS,
      maxAttempts: MAX_ATTEMPTS,
    },
  });
});

beforeEach(async () => {
  // Pendências deixadas por testes anteriores saem do caminho; cada teste começa com o relógio na hora real.
  await app.sql`
    UPDATE wager_transactions SET next_reference_attempt_at = now() + interval '10 years'
     WHERE status = 'PENDING_REFERENCE'`;
  clock = new TestClock();
  worker = workerOf(app, clock);
});

afterAll(async () => {
  await app.close();
  await queues.destroy();
});

// ---- apoio

const BRL = (amount: string) => ({ amount, currency: 'BRL' });

interface StoredTransaction {
  status: string;
  failure_code: string | null;
  reference_transaction_id: string | null;
  reference_attempts: number;
  next_reference_attempt_at: Date | null;
}

async function stored(transactionId: string): Promise<StoredTransaction> {
  const [row] = await app.sql`
    SELECT status, failure_code, reference_transaction_id, reference_attempts, next_reference_attempt_at
      FROM wager_transactions WHERE id = ${transactionId}`;
  return row as StoredTransaction;
}

/** Envia um REFUND/ROLLBACK cuja referência ainda não existe e confere que ficou pendente. */
async function submitOrphan(wallet: WalletJson, kind: 'REFUND' | 'ROLLBACK', amount: string, reference: string) {
  const payload = app.payload(wallet, kind, amount, { referenceExternalTransactionId: reference });
  const response = await app.submit(payload);
  expect(response.status).toBe(202);
  expect(response.body.status).toBe('PENDING_REFERENCE');
  return { payload, transactionId: response.body.transactionId as string };
}

async function eventPayloads(aggregateId: string) {
  const rows = await app.sql`
    SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = ${aggregateId} ORDER BY occurred_at, id`;
  return [...rows] as { event_type: string; payload: Record<string, any> }[];
}

// ---- testes

describe('a referência chega depois', () => {
  test('REFUND antes da BET: fica pendente, a BET chega e o worker aplica o estorno', async () => {
    const wallet = await app.createWallet('100.00');
    const reference = `bet-${Bun.randomUUIDv7()}`;
    const refund = await submitOrphan(wallet, 'REFUND', '30.00', reference);
    expect(await app.balanceOf(wallet.id)).toBe('100.00');

    // Antes de vencer a primeira tentativa o worker nem olha para ela.
    expect((await worker.execute(BATCH)).found).toBe(0);

    const bet = await app.submit(app.payload(wallet, 'BET', '30.00', { externalTransactionId: reference }));
    expect(bet.status).toBe(201);
    expect(await app.balanceOf(wallet.id)).toBe('70.00');
    expect((await stored(refund.transactionId)).status).toBe('PENDING_REFERENCE'); // a chegada da BET não resolve sozinha

    clock.advance(BASE_DELAY_MS);
    const result = await worker.execute(BATCH);

    expect(result.found).toBe(1);
    expect(result.outcomes.RESOLVED).toBe(1);
    expect(await stored(refund.transactionId)).toMatchObject({
      status: 'PROCESSED',
      failure_code: null,
      reference_transaction_id: bet.body.transactionId,
      next_reference_attempt_at: null,
    });
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
    expect(await app.ledgerOf(wallet.id)).toMatchObject([
      { direction: 'CREDIT', amount: '100.00', balance_after: '100.00' }, // abertura
      { direction: 'DEBIT', amount: '30.00', balance_after: '70.00' }, // aposta
      { direction: 'CREDIT', amount: '30.00', balance_before: '70.00', balance_after: '100.00' }, // estorno
    ]);
    expect(await app.ledgerMatchesBalance(wallet.id)).toBe(true);

    // Eventos: o aviso de pendência da entrada + o desfecho gravado pelo worker.
    const events = await eventPayloads(refund.transactionId);
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
    const processed = events[1]?.payload as Record<string, any>;
    expect(processed.causationId).toBe(refund.transactionId); // causa: a própria transação pendente
    expect(processed.correlationId).not.toBe(events[0]?.payload.correlationId); // correlação nova por resolução
    expect(await app.eventsOf(wallet.id)).toHaveLength(3); // WalletBalanceChanged: abertura, aposta, estorno

    // Reenviar o mesmo REFUND agora devolve o desfecho final, sem novo efeito.
    const replay = await app.submit(refund.payload);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', balance: BRL('100.00'), idempotentReplay: true });
    expect((await worker.execute(BATCH)).found).toBe(0);
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
  });

  test('ROLLBACK antes do WIN: desfaz o crédito quando o WIN chega', async () => {
    const wallet = await app.createWallet('100.00');
    const reference = `win-${Bun.randomUUIDv7()}`;
    const rollback = await submitOrphan(wallet, 'ROLLBACK', '50.00', reference);

    const win = await app.submit(app.payload(wallet, 'WIN', '50.00', { externalTransactionId: reference }));
    expect(win.status).toBe(201);
    expect(await app.balanceOf(wallet.id)).toBe('150.00');

    clock.advance(BASE_DELAY_MS);
    expect((await worker.execute(BATCH)).outcomes.RESOLVED).toBe(1);

    expect(await stored(rollback.transactionId)).toMatchObject({
      status: 'PROCESSED',
      reference_transaction_id: win.body.transactionId,
    });
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
    expect((await app.ledgerOf(wallet.id)).at(-1)).toMatchObject({
      direction: 'DEBIT',
      amount: '50.00',
      balance_before: '150.00',
      balance_after: '100.00',
    });
    expect(await app.ledgerMatchesBalance(wallet.id)).toBe(true);
  });

  test('ROLLBACK antes da BET: devolve o valor apostado', async () => {
    const wallet = await app.createWallet('100.00');
    const reference = `bet-${Bun.randomUUIDv7()}`;
    const rollback = await submitOrphan(wallet, 'ROLLBACK', '20.00', reference);
    await app.submit(app.payload(wallet, 'BET', '20.00', { externalTransactionId: reference }));

    clock.advance(BASE_DELAY_MS);
    await worker.execute(BATCH);

    expect((await stored(rollback.transactionId)).status).toBe('PROCESSED');
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
    expect(await app.ledgerMatchesBalance(wallet.id)).toBe(true);
  });

  test('referência ainda ausente: conta a tentativa, dobra o intervalo e resolve numa tentativa posterior', async () => {
    const wallet = await app.createWallet('100.00');
    const reference = `bet-${Bun.randomUUIDv7()}`;
    const refund = await submitOrphan(wallet, 'REFUND', '30.00', reference);

    // 1ª tentativa: nada ainda.
    clock.advance(BASE_DELAY_MS);
    const first = await worker.execute(BATCH);
    expect(first.outcomes.RESCHEDULED).toBe(1);
    const afterFirst = await stored(refund.transactionId);
    expect(afterFirst).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 1 });
    const wait = (afterFirst.next_reference_attempt_at as Date).getTime() - clock.now().getTime();
    expect(wait).toBeGreaterThan(2 * BASE_DELAY_MS - 1_000); // o backoff dobrou: ~20s
    expect(wait).toBeLessThanOrEqual(2 * BASE_DELAY_MS);
    // A nova tentativa frustrada não repete o evento de pendência.
    expect(await app.eventsOf(refund.transactionId)).toEqual(['WagerTransactionPendingReference']);

    // Ainda dentro do backoff: o worker não a pega.
    clock.advance(BASE_DELAY_MS);
    expect((await worker.execute(BATCH)).found).toBe(0);

    // A BET chega; na 2ª tentativa o estorno é aplicado.
    await app.submit(app.payload(wallet, 'BET', '30.00', { externalTransactionId: reference }));
    clock.advance(BASE_DELAY_MS);
    expect((await worker.execute(BATCH)).outcomes.RESOLVED).toBe(1);
    expect(await stored(refund.transactionId)).toMatchObject({ status: 'PROCESSED', reference_attempts: 1 });
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
  });
});

describe('a referência nunca chega', () => {
  test('esgotadas as tentativas: REJECTED com REFERENCE_NOT_FOUND, evento publicado e saldo intacto', async () => {
    const wallet = await app.createWallet('100.00');
    const reference = `bet-${Bun.randomUUIDv7()}`;
    const refund = await submitOrphan(wallet, 'REFUND', '30.00', reference);

    // 3 tentativas, com 10s, 20s e 40s de espera entre elas.
    clock.advance(BASE_DELAY_MS);
    expect((await worker.execute(BATCH)).outcomes.RESCHEDULED).toBe(1);
    clock.advance(2 * BASE_DELAY_MS);
    expect((await worker.execute(BATCH)).outcomes.RESCHEDULED).toBe(1);
    expect((await stored(refund.transactionId)).status).toBe('PENDING_REFERENCE');
    clock.advance(4 * BASE_DELAY_MS);
    const last = await worker.execute(BATCH);

    expect(last.outcomes.REJECTED).toBe(1);
    expect(await stored(refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      reference_transaction_id: null,
      reference_attempts: MAX_ATTEMPTS,
      next_reference_attempt_at: null,
    });
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
    expect(await app.ledgerOf(wallet.id)).toHaveLength(1); // só a abertura
    expect(await app.ledgerMatchesBalance(wallet.id)).toBe(true);

    // O evento de rejeição está na outbox...
    const events = await eventPayloads(refund.transactionId);
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(events[1]?.payload.data).toMatchObject({
      transactionId: refund.transactionId,
      failureCode: 'REFERENCE_NOT_FOUND',
    });

    // ...e o publisher o entrega na fila de eventos.
    const publisher = app.app.get(PublishOutboxBatch);
    while ((await publisher.execute()).claimed > 0) {
      // drena a outbox
    }
    const published = (await queues.drain(queues.eventsUrl, 1)).map((message) => JSON.parse(message.Body as string));
    const rejection = published.find(
      (event) => event.eventType === 'WagerTransactionRejected' && event.aggregateId === refund.transactionId,
    );
    expect(rejection.eventId).toBe(events[1]?.payload.eventId);
    expect(rejection.data.failureCode).toBe('REFERENCE_NOT_FOUND');

    // REJECTED é terminal: a BET chegando depois não ressuscita o estorno.
    await app.submit(app.payload(wallet, 'BET', '30.00', { externalTransactionId: reference }));
    clock.advance(10 * MAX_DELAY_MS);
    expect((await worker.execute(BATCH)).found).toBe(0);
    const replay = await app.submit(refund.payload);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ failureCode: 'REFERENCE_NOT_FOUND', idempotentReplay: true });
    expect(await app.balanceOf(wallet.id)).toBe('70.00'); // só a aposta
  });
});

describe('a referência chega, mas não serve', () => {
  test('valor diferente do da referência: REJECTED com REFERENCE_AMOUNT_MISMATCH', async () => {
    const wallet = await app.createWallet('100.00');
    const reference = `bet-${Bun.randomUUIDv7()}`;
    const refund = await submitOrphan(wallet, 'REFUND', '30.00', reference);
    await app.submit(app.payload(wallet, 'BET', '25.00', { externalTransactionId: reference }));

    clock.advance(BASE_DELAY_MS);
    expect((await worker.execute(BATCH)).outcomes.REJECTED).toBe(1);

    expect(await stored(refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_AMOUNT_MISMATCH',
    });
    expect(await app.balanceOf(wallet.id)).toBe('75.00');
    expect(await app.eventsOf(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  });

  test('a referência foi rejeitada: REJECTED com REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await app.createWallet('10.00');
    const reference = `bet-${Bun.randomUUIDv7()}`;
    const refund = await submitOrphan(wallet, 'REFUND', '50.00', reference);
    const bet = await app.submit(app.payload(wallet, 'BET', '50.00', { externalTransactionId: reference }));
    expect(bet.status).toBe(422); // saldo insuficiente

    clock.advance(BASE_DELAY_MS);
    await worker.execute(BATCH);

    expect(await stored(refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_PROCESSED',
    });
    expect(await app.balanceOf(wallet.id)).toBe('10.00');
  });

  test('dois estornos pendentes da mesma aposta: só um é aplicado', async () => {
    const wallet = await app.createWallet('100.00');
    const reference = `bet-${Bun.randomUUIDv7()}`;
    const first = await submitOrphan(wallet, 'REFUND', '40.00', reference);
    const second = await submitOrphan(wallet, 'REFUND', '40.00', reference);
    await app.submit(app.payload(wallet, 'BET', '40.00', { externalTransactionId: reference }));

    clock.advance(BASE_DELAY_MS);
    const result = await worker.execute(BATCH);

    expect(result.outcomes).toMatchObject({ RESOLVED: 1, REJECTED: 1 });
    const outcomes = [await stored(first.transactionId), await stored(second.transactionId)];
    expect(outcomes.map((row) => row.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(outcomes.find((row) => row.status === 'REJECTED')?.failure_code).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await app.balanceOf(wallet.id)).toBe('100.00'); // devolvido uma vez só
    expect(await app.ledgerMatchesBalance(wallet.id)).toBe(true);
  });
});

describe('várias instâncias', () => {
  test('3 workers no mesmo instante sobre as mesmas pendentes: cada estorno é aplicado uma única vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => app.createWallet('100.00')));
    const refunds = await Promise.all(
      wallets.map(async (wallet) => {
        const reference = `bet-${Bun.randomUUIDv7()}`;
        const refund = await submitOrphan(wallet, 'REFUND', '30.00', reference);
        await app.submit(app.payload(wallet, 'BET', '30.00', { externalTransactionId: reference }));
        return refund;
      }),
    );
    const second = await app.startSibling();
    const third = await app.startSibling();

    try {
      clock.advance(BASE_DELAY_MS);
      const results = await Promise.all([
        worker.execute(BATCH),
        workerOf(second, clock).execute(BATCH),
        workerOf(third, clock).execute(BATCH),
      ]);

      // Todas viram as mesmas candidatas; o lock da wallet e a releitura deixam uma só aplicar.
      const total = (outcome: 'RESOLVED' | 'SKIPPED' | 'ERRORED') =>
        results.reduce((sum, result) => sum + result.outcomes[outcome], 0);
      expect(total('RESOLVED')).toBe(8);
      expect(total('ERRORED')).toBe(0);
      expect(total('RESOLVED') + total('SKIPPED')).toBe(results.reduce((sum, result) => sum + result.found, 0));

      for (const [index, wallet] of wallets.entries()) {
        expect((await stored(refunds[index]?.transactionId as string)).status).toBe('PROCESSED');
        expect(await app.balanceOf(wallet.id)).toBe('100.00');
        expect(await app.ledgerOf(wallet.id)).toHaveLength(3); // abertura, aposta e UM estorno
        expect(await app.ledgerMatchesBalance(wallet.id)).toBe(true);
        expect(await app.eventsOf(refunds[index]?.transactionId as string)).toEqual([
          'WagerTransactionPendingReference',
          'WagerTransactionProcessed',
        ]);
      }
    } finally {
      await second.close();
      await third.close();
    }
  });
});

describe('worker em segundo plano, com o relógio de verdade', () => {
  let live: TestApp;

  beforeAll(async () => {
    live = await startTestApp('pending_reference_live', {
      pendingReference: {
        ...loadEnv().pendingReference,
        enabled: true,
        pollIntervalMs: 50,
        retryBaseDelayMs: 200, // 200ms, 400ms
        retryMaxDelayMs: 400,
        maxAttempts: 2,
      },
    });
  });

  afterAll(async () => {
    await live.close();
  });

  const statusOf = async (transactionId: string) =>
    (await live.get(`/wagering/transactions/${transactionId}`)).body.status as string;

  test('REFUND antes da BET é resolvido sozinho depois que a BET chega', async () => {
    const wallet = await live.createWallet('100.00');
    const reference = `bet-${Bun.randomUUIDv7()}`;
    const refund = await live.submit(
      live.payload(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: reference }),
    );
    expect(refund.status).toBe(202);
    await live.submit(live.payload(wallet, 'BET', '30.00', { externalTransactionId: reference }));

    await eventually('o worker aplicar o estorno', async () => (await statusOf(refund.body.transactionId)) === 'PROCESSED');

    expect(await live.balanceOf(wallet.id)).toBe('100.00');
    expect(await live.ledgerMatchesBalance(wallet.id)).toBe(true);
  });

  test('sem a referência, o worker desiste sozinho e rejeita', async () => {
    const wallet = await live.createWallet('100.00');
    const refund = await live.submit(
      live.payload(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: `bet-${Bun.randomUUIDv7()}` }),
    );

    await eventually('o worker rejeitar o estorno', async () => (await statusOf(refund.body.transactionId)) === 'REJECTED');

    const stored = await live.get(`/wagering/transactions/${refund.body.transactionId}`);
    expect(stored.body.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(await live.balanceOf(wallet.id)).toBe('100.00');
  });
});
