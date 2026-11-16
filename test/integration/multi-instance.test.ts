import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Cluster, type ClusterNode } from '../support/cluster';
import type { ApiClient, HttpResult, TransactionPayload, WalletJson } from '../support/test-app';
import { eventually, type TestQueues } from '../support/test-queues';

setDefaultTimeout(120_000);

const INSTANCES = 3;

let cluster: Cluster;
let nodes: readonly ClusterNode[];
let clients: ApiClient[];
let queues: TestQueues;

beforeAll(async () => {
  cluster = await Cluster.start('multi_instance', INSTANCES, {
    DB_POOL_MAX: '10',
    DB_LOCK_TIMEOUT_MS: '2000',
    SQS_CONSUMER_ENABLED: 'true',
    SQS_CONSUMER_CONCURRENCY: '3',
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
    SQS_MAX_ATTEMPTS: '5',
    SQS_RETRY_BASE_DELAY_SECONDS: '1',
    SQS_SHUTDOWN_GRACE_MS: '5000',
    OUTBOX_PUBLISHER_ENABLED: 'true',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_WORKER_ENABLED: 'true',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_RETRY_BASE_DELAY_MS: '200',
    PENDING_REFERENCE_RETRY_MAX_DELAY_MS: '1000',
    PENDING_REFERENCE_MAX_ATTEMPTS: '60',
  });
  nodes = cluster.nodes;
  clients = cluster.clients;
  queues = cluster.queues;
});

afterEach(async () => {
  await cluster.heal();
  expect(await brokenWallets()).toEqual({ balanceDiffersFromLedger: 0, brokenChains: 0, negativeBalances: 0 });
});

afterAll(async () => {
  await cluster.stop();
});

const client = (index: number): ApiClient => clients[index % INSTANCES] as ApiClient;

async function brokenWallets() {
  const [row] = await cluster.sql`
    SELECT
      (SELECT count(*)::int FROM wallets w
        WHERE w.balance <> COALESCE((SELECT SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END)
                                       FROM wallet_ledger_entries e WHERE e.wallet_id = w.id), 0)) AS balance_differs,
      (SELECT count(*)::int FROM (
          SELECT balance_before, LAG(balance_after) OVER (PARTITION BY wallet_id ORDER BY seq) AS previous
            FROM wallet_ledger_entries) chain
        WHERE previous IS NOT NULL AND previous <> balance_before) AS broken_chains,
      (SELECT count(*)::int FROM wallets WHERE balance < 0) AS negative`;
  return {
    balanceDiffersFromLedger: row.balance_differs as number,
    brokenChains: row.broken_chains as number,
    negativeBalances: row.negative as number,
  };
}

async function expectReconciled(wallet: WalletJson, expectedBalance: string, instance = 0): Promise<void> {
  const report = await client(instance).post(`/wallets/${wallet.id}/reconciliation`);
  expect(report.status).toBe(200);
  expect(report.body).toMatchObject({
    consistent: true,
    storedBalance: { amount: expectedBalance, currency: 'BRL' },
    calculatedBalance: { amount: expectedBalance, currency: 'BRL' },
  });
}

async function transactionByExternalId(externalTransactionId: string) {
  const [row] = await cluster.sql`
    SELECT id, status, failure_code FROM wager_transactions WHERE external_transaction_id = ${externalTransactionId}`;
  return row as { id: string; status: string; failure_code: string | null } | undefined;
}

async function count(query: Promise<{ n: number }[]>): Promise<number> {
  const [row] = await query;
  return (row as { n: number }).n;
}

const inboxRows = (messageId: string) =>
  count(cluster.sql`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ${messageId}`);

const pendingOutbox = () =>
  count(cluster.sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);

const transactionsOf = (walletIds: string[]) =>
  count(cluster.sql`
    SELECT count(*)::int AS n FROM wager_transactions
     WHERE wallet_id IN ${cluster.sql(walletIds)} AND kind <> 'OPENING'`);

const queueIsEmpty = async () => (await queues.depth(queues.queueUrl)) === 0;

const statuses = (responses: HttpResult[]) => responses.map((response) => response.status);

const tally = (values: (string | number)[]) =>
  values.reduce<Record<string, number>>((totals, value) => ({ ...totals, [value]: (totals[value] ?? 0) + 1 }), {});

async function settleEvents(): Promise<void> {
  await eventually('outbox drenada', async () => (await pendingOutbox()) === 0);
  await queues.drain(queues.eventsUrl, 0);
}

async function drainEventIds(): Promise<string[]> {
  const messages = await queues.drain(queues.eventsUrl, 1);
  return messages.map((message) => (JSON.parse(message.Body as string) as { eventId: string }).eventId);
}

describe('3 instâncias disputando a mesma wallet', () => {
  test('saldo 100.00 e uma BET de 80.00 em cada instância ao mesmo tempo: só uma é aprovada', async () => {
    const wallet = await client(0).createWallet('100.00');

    const responses = await Promise.all(
      clients.map((instance) => instance.submit(instance.payload(wallet, 'BET', '80.00'))),
    );

    expect(tally(statuses(responses))).toEqual({ 201: 1, 422: 2 });
    expect(responses.filter((response) => response.status === 422).map((response) => response.body.failureCode)).toEqual([
      'INSUFFICIENT_FUNDS',
      'INSUFFICIENT_FUNDS',
    ]);
    expect(await client(0).balanceOf(wallet.id)).toBe('20.00');
    expect(await client(0).ledgerOf(wallet.id)).toHaveLength(2);
    await expectReconciled(wallet, '20.00');
  });

  test('150 apostas de 1.00 espalhadas pelas 3 instâncias, saldo 100.00: exatamente 100 aprovadas', async () => {
    const wallet = await client(0).createWallet('100.00');

    const responses = await Promise.all(
      Array.from({ length: 150 }, (_, index) => client(index).submit(client(index).payload(wallet, 'BET', '1.00'))),
    );

    expect(tally(statuses(responses))).toEqual({ 201: 100, 422: 50 });
    expect(await client(0).balanceOf(wallet.id)).toBe('0.00');
    const ledger = await client(0).ledgerOf(wallet.id);
    expect(ledger).toHaveLength(101);
    expect(ledger.at(-1)?.balance_after).toBe('0.00');
    const observed = responses.filter((response) => response.status === 201).map((response) => response.body.balance.amount);
    expect(new Set(observed).size).toBe(100);
    const stored = await client(1).get(`/wallets/${wallet.id}`);
    expect(stored.body.version).toBe(wallet.version + 100);
    await expectReconciled(wallet, '0.00', 2);
  });

  test('a mesma aposta enviada 60 vezes às 3 instâncias: um débito só', async () => {
    const wallet = await client(0).createWallet('100.00');
    const payload = client(0).payload(wallet, 'BET', '25.00');

    const responses = await Promise.all(Array.from({ length: 60 }, (_, index) => client(index).submit(payload)));

    expect(tally(statuses(responses))).toEqual({ 201: 60 });
    expect(responses.filter((response) => response.body.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(new Set(responses.map((response) => response.body.balance.amount))).toEqual(new Set(['75.00']));
    expect(await client(0).balanceOf(wallet.id)).toBe('75.00');
    expect(await client(0).ledgerOf(wallet.id)).toHaveLength(2);
    await expectReconciled(wallet, '75.00', 1);
  });

  test('créditos e débitos misturados pelas 3 instâncias: nenhum se perde', async () => {
    const wallet = await client(0).createWallet('100.00');

    const responses = await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        client(index).submit(client(index).payload(wallet, index % 2 === 0 ? 'WIN' : 'BET', index % 2 === 0 ? '3.00' : '2.00')),
      ),
    );

    expect(tally(statuses(responses))).toEqual({ 201: 120 });
    expect(await client(0).balanceOf(wallet.id)).toBe('160.00');
    expect(await client(0).ledgerOf(wallet.id)).toHaveLength(121);
    await expectReconciled(wallet, '160.00');
  });
});

describe('3 instâncias, wallets diferentes', () => {
  test('20 wallets com 15 apostas cada, espalhadas pelas instâncias: todas aplicadas', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, (_, index) => client(index).createWallet('100.00')));

    const responses = await Promise.all(
      wallets.flatMap((wallet, walletIndex) =>
        Array.from({ length: 15 }, (_, betIndex) => {
          const instance = client(walletIndex + betIndex);
          return instance.submit(instance.payload(wallet, 'BET', '1.00'));
        }),
      ),
    );

    expect(tally(statuses(responses))).toEqual({ 201: 300 });
    for (const wallet of wallets) {
      expect(await client(0).balanceOf(wallet.id)).toBe('85.00');
      expect(await client(0).ledgerOf(wallet.id)).toHaveLength(16);
    }
    await expectReconciled(wallets[0] as WalletJson, '85.00');
  });

  test('uma wallet travada não segura as outras em nenhuma instância (o lock é por wallet, não global)', async () => {
    const [locked, ...free] = await Promise.all(Array.from({ length: 4 }, () => client(0).createWallet('100.00')));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let acquired!: () => void;
    const lockHeld = new Promise<void>((resolve) => (acquired = resolve));
    const holder = cluster.sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${(locked as WalletJson).id} FOR UPDATE`;
      acquired();
      await gate;
    });

    try {
      await lockHeld;
      let waitingFinished = false;
      const waiting = Promise.all(
        clients.map((instance) => instance.submit(instance.payload(locked as WalletJson, 'BET', '10.00'))),
      ).then((responses) => {
        waitingFinished = true;
        return responses;
      });

      const others = await Promise.all(
        free.flatMap((wallet) => clients.map((instance) => instance.submit(instance.payload(wallet, 'BET', '10.00')))),
      );
      expect(tally(statuses(others))).toEqual({ 201: 9 });
      expect(waitingFinished).toBe(false);

      release();
      await holder;
      expect(tally(statuses(await waiting))).toEqual({ 201: 3 });
    } finally {
      release();
      await holder.catch(() => undefined);
    }

    expect(await client(0).balanceOf((locked as WalletJson).id)).toBe('70.00');
    for (const wallet of free) {
      expect(await client(0).balanceOf(wallet.id)).toBe('70.00');
    }
  });
});

describe('3 consumers na mesma fila', () => {
  test('mensagens para a mesma wallet e para wallets diferentes: nenhuma se perde nem duplica', async () => {
    const shared = await client(0).createWallet('100.00');
    const others = await Promise.all(Array.from({ length: 10 }, () => client(1).createWallet('100.00')));
    for (const node of nodes) {
      node.proxy.reset();
    }

    const sendAll = async (wallet: WalletJson, amount: number): Promise<string[]> => {
      const ids: string[] = [];
      for (let index = 0; index < amount; index++) {
        ids.push(await queues.send(client(0).payload(wallet, 'BET', '5.00')));
      }
      return ids;
    };
    const messageIds = (
      await Promise.all([sendAll(shared, 40), ...others.map((wallet) => sendAll(wallet, 6))])
    ).flat();
    await eventually('fila vazia', queueIsEmpty, 60_000);

    expect(await queues.depth(queues.dlqUrl)).toBe(0);
    expect(await client(0).balanceOf(shared.id)).toBe('0.00');
    const sharedOutcomes = await cluster.sql`
      SELECT status, count(*)::int AS n FROM wager_transactions
       WHERE wallet_id = ${shared.id} AND kind = 'BET' GROUP BY status ORDER BY status`;
    expect([...sharedOutcomes].map((row) => [row.status, row.n])).toEqual([
      ['PROCESSED', 20],
      ['REJECTED', 20],
    ]);
    for (const wallet of others) {
      expect(await client(0).balanceOf(wallet.id)).toBe('70.00');
      expect(await client(0).ledgerOf(wallet.id)).toHaveLength(7);
    }
    const inbox = await cluster.sql`
      SELECT count(*)::int AS n, count(DISTINCT message_id)::int AS distinct_ids
        FROM inbox_messages WHERE message_id IN ${cluster.sql(messageIds)}`;
    expect(inbox[0]).toMatchObject({ n: 100, distinct_ids: 100 });
    expect(nodes.map((node) => node.proxy.deliveries > 0)).toEqual([true, true, true]);
    await expectReconciled(shared, '0.00');
  });

  test('a mesma operação chega pela fila e por HTTP nas 3 instâncias: um efeito', async () => {
    const wallet = await client(0).createWallet('100.00');
    const payloads = Array.from({ length: 10 }, () => client(0).payload(wallet, 'BET', '4.00'));

    const responses = (
      await Promise.all(
        payloads.map(async (payload) => {
          const [, ...http] = await Promise.all([
            queues.send(payload),
            ...clients.map((instance) => instance.submit(payload)),
          ]);
          return http;
        }),
      )
    ).flat();
    await eventually('fila vazia', queueIsEmpty, 30_000);

    expect(tally(statuses(responses))).toEqual({ 201: 30 });
    expect(await client(0).balanceOf(wallet.id)).toBe('60.00');
    expect(await client(0).ledgerOf(wallet.id)).toHaveLength(11);
    expect(await queues.depth(queues.dlqUrl)).toBe(0);
  });
});

describe('processo morto no meio do fluxo', () => {
  test('worker morto depois do commit e antes do ack: a mensagem volta, outra instância a reconhece e nada duplica', async () => {
    const wallet = await client(0).createWallet('100.00');
    const payload = client(0).payload(wallet, 'BET', '25.00');
    const holds = nodes.map((node) => node.proxy.hold('DeleteMessage', 'request'));

    const messageId = await queues.send(payload);
    const victimIndex = await Promise.race(holds.map((hold, index) => hold.seen.then(() => index)));
    const victim = nodes[victimIndex] as ClusterNode;

    expect(await transactionByExternalId(payload.externalTransactionId)).toMatchObject({ status: 'PROCESSED' });
    expect(await client(0).balanceOf(wallet.id)).toBe('75.00');
    expect(await inboxRows(messageId)).toBe(1);

    await victim.kill();
    holds.forEach((hold, index) => (index === victimIndex ? hold.drop() : hold.release()));
    expect(victim.isRunning).toBe(false);
    expect(await queues.depth(queues.queueUrl)).toBe(1);

    await eventually('redelivery reconhecida e apagada', queueIsEmpty, 30_000);
    const survivors = nodes.filter((_, index) => index !== victimIndex);
    expect(survivors.some((node) => node.proxy.delivered(messageId))).toBe(true);

    expect(await client(victimIndex + 1).balanceOf(wallet.id)).toBe('75.00');
    expect(await client(victimIndex + 1).ledgerOf(wallet.id)).toHaveLength(2);
    expect(await inboxRows(messageId)).toBe(1);
    expect(await transactionsOf([wallet.id])).toBe(1);
    const transaction = await transactionByExternalId(payload.externalTransactionId);
    expect(await client(victimIndex + 1).eventsOf(transaction?.id as string)).toEqual(['WagerTransactionProcessed']);
    expect(await queues.depth(queues.dlqUrl)).toBe(0);

    await victim.start();
    await expectReconciled(wallet, '75.00', victimIndex);
  });

  test('worker morto no meio da transação (antes do commit): nada fica gravado e a mensagem é processada por outra instância', async () => {
    const wallet = await client(0).createWallet('100.00');
    const payload = client(0).payload(wallet, 'BET', '25.00');
    for (const node of nodes) {
      node.proxy.reset();
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let acquired!: () => void;
    const lockHeld = new Promise<void>((resolve) => (acquired = resolve));
    const holder = cluster.sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      acquired();
      await gate;
    });
    const lockWaiters = () =>
      count(cluster.sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`);

    let messageId: string;
    let victimIndex: number;
    try {
      await lockHeld;
      messageId = await queues.send(payload);
      await eventually('uma instância parada esperando o lock da wallet', async () => (await lockWaiters()) === 1);
      victimIndex = nodes.findIndex((node) => node.proxy.delivered(messageId));
      expect(victimIndex).toBeGreaterThanOrEqual(0);

      await (nodes[victimIndex] as ClusterNode).kill();

      await eventually('transação da instância morta desfeita', async () => (await lockWaiters()) === 0);
      expect(await inboxRows(messageId)).toBe(0);
      expect(await transactionByExternalId(payload.externalTransactionId)).toBeUndefined();
    } finally {
      release();
      await holder.catch(() => undefined);
    }

    await eventually('mensagem processada por outra instância', queueIsEmpty, 30_000);
    expect(await transactionByExternalId(payload.externalTransactionId)).toMatchObject({ status: 'PROCESSED' });
    expect(await inboxRows(messageId)).toBe(1);
    expect(await client(victimIndex + 1).balanceOf(wallet.id)).toBe('75.00');
    expect(await client(victimIndex + 1).ledgerOf(wallet.id)).toHaveLength(2);
    expect(await queues.depth(queues.dlqUrl)).toBe(0);
  });

  test('publisher morto depois de enviar ao SQS e antes de marcar: outra instância republica o mesmo evento', async () => {
    const wallet = await client(0).createWallet('100.00');
    await settleEvents();
    for (const node of nodes) {
      node.proxy.reset();
    }
    const holds = nodes.map((node) => node.proxy.hold('SendMessageBatch', 'response'));

    const bet = await client(0).submit(client(0).payload(wallet, 'BET', '10.00'));
    expect(bet.status).toBe(201);
    const victimIndex = await Promise.race(holds.map((hold, index) => hold.seen.then(() => index)));

    const pending = await cluster.sql`SELECT id FROM outbox_messages WHERE published_at IS NULL ORDER BY id`;
    const eventIds = [...pending].map((row) => row.id as string);
    expect(eventIds).toHaveLength(2);
    expect(await queues.depth(queues.eventsUrl)).toBe(2);

    await (nodes[victimIndex] as ClusterNode).kill();
    holds.forEach((hold, index) => (index === victimIndex ? hold.drop() : hold.release()));

    await eventually('eventos republicados e marcados', async () => (await pendingOutbox()) === 0, 30_000);
    const sent = nodes
      .flatMap((node) => node.proxy.requests('SendMessageBatch') as { Entries: { Id: string }[] }[])
      .flatMap((request) => request.Entries.map((entry) => entry.Id))
      .filter((id) => eventIds.includes(id));
    expect(sent).toHaveLength(4);
    expect((await drainEventIds()).sort()).toEqual([...eventIds].sort());

    expect(await client(victimIndex + 1).balanceOf(wallet.id)).toBe('90.00');
  });
});

describe('reinício do serviço', () => {
  test('reinício gracioso (SIGTERM) das 3 instâncias, uma por vez, sob carga: toda operação é aplicada exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => client(0).createWallet('10000.00')));
    const sent: TransactionPayload[] = [];
    const finalStatuses: number[] = [];
    let failedAttempts = 0;
    let restarting = true;

    const deliver = async (payload: TransactionPayload, firstInstance: number): Promise<number> => {
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          const response = await client(firstInstance + attempt).submit(payload);
          if (response.status !== 503) {
            return response.status;
          }
        } catch {
        }
        failedAttempts += 1;
        await Bun.sleep(20);
      }
      throw new Error('operação não foi aceita por nenhuma instância');
    };
    const provider = async (providerIndex: number): Promise<void> => {
      for (let sequence = 0; restarting || sequence < 20; sequence++) {
        const wallet = wallets[(providerIndex + sequence) % wallets.length] as WalletJson;
        const payload = client(0).payload(wallet, 'BET', '1.00');
        sent.push(payload);
        finalStatuses.push(await deliver(payload, providerIndex + sequence));
        await Bun.sleep(10);
      }
    };
    const load = Promise.all(Array.from({ length: 6 }, (_, index) => provider(index)));

    try {
      for (const node of nodes) {
        await Bun.sleep(300);
        const stoppedAt = Date.now();
        await node.terminate();
        expect(Date.now() - stoppedAt).toBeLessThan(10_000);
        expect(node.isRunning).toBe(false);
        await node.start();
      }
    } finally {
      restarting = false;
    }
    await load;

    expect(failedAttempts).toBeGreaterThan(0);
    expect(tally(finalStatuses)).toEqual({ 201: sent.length });

    expect(await transactionsOf(wallets.map((wallet) => wallet.id))).toBe(sent.length);
    for (const wallet of wallets) {
      const bets = sent.filter((payload) => payload.walletId === wallet.id).length;
      expect(await client(0).balanceOf(wallet.id)).toBe(`${10_000 - bets}.00`);
      expect(await client(0).ledgerOf(wallet.id)).toHaveLength(1 + bets);
    }

    const first = sent[0] as TransactionPayload;
    const replays = await Promise.all(clients.map((instance) => instance.submit(first)));
    expect(tally(statuses(replays))).toEqual({ 201: 3 });
    expect(replays.every((response) => response.body.idempotentReplay === true)).toBe(true);
    await expectReconciled(wallets[0] as WalletJson, await client(0).balanceOf((wallets[0] as WalletJson).id), 2);
  });

  test('queda de todas as instâncias (SIGKILL) com a fila cheia e reinício: tudo é processado e publicado uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => client(0).createWallet('100.00')));
    const walletIds = wallets.map((wallet) => wallet.id);
    await settleEvents();
    const knownEvents = new Set(
      [...(await cluster.sql`SELECT id FROM outbox_messages`)].map((row) => row.id as string),
    );

    await Promise.all(nodes.map((node) => node.terminate()));
    const orphanWallet = wallets[0] as WalletJson;
    const lateBet = client(0).payload(orphanWallet, 'BET', '2.00');
    const orphanRefund = client(0).payload(orphanWallet, 'REFUND', '2.00', {
      referenceExternalTransactionId: lateBet.externalTransactionId,
    });
    await Promise.all(
      wallets.map(async (wallet, index) => {
        const payloads = Array.from({ length: 20 }, () => client(0).payload(wallet, 'BET', '2.00'));
        if (index === 0) {
          payloads.unshift(orphanRefund);
          payloads[payloads.length - 1] = lateBet;
        }
        for (const payload of payloads) {
          await queues.send(payload);
        }
      }),
    );
    expect(await queues.depth(queues.queueUrl)).toBe(121);

    await cluster.heal();
    await eventually('parte da fila processada', async () => (await transactionsOf(walletIds)) >= 30, 30_000);
    await Promise.all(nodes.map((node) => node.kill()));

    const processedAtCrash = await transactionsOf(walletIds);
    expect(processedAtCrash).toBeLessThan(121);
    expect(await brokenWallets()).toEqual({ balanceDiffersFromLedger: 0, brokenChains: 0, negativeBalances: 0 });
    expect(await queues.depth(queues.queueUrl)).toBeGreaterThan(0);

    await cluster.heal();
    await eventually('fila vazia depois do reinício', queueIsEmpty, 60_000);
    await eventually(
      'estorno pendente resolvido',
      async () => (await transactionByExternalId(orphanRefund.externalTransactionId))?.status === 'PROCESSED',
      60_000,
    );
    await eventually('outbox publicada', async () => (await pendingOutbox()) === 0, 30_000);

    expect(await queues.depth(queues.dlqUrl)).toBe(0);
    const outcomes = await cluster.sql`
      SELECT status, count(*)::int AS n FROM wager_transactions
       WHERE wallet_id IN ${cluster.sql(walletIds)} AND kind <> 'OPENING' GROUP BY status`;
    expect([...outcomes].map((row) => [row.status, row.n])).toEqual([['PROCESSED', 121]]);
    expect(await client(0).balanceOf(orphanWallet.id)).toBe('62.00');
    expect(await client(0).ledgerOf(orphanWallet.id)).toHaveLength(22);
    for (const wallet of wallets.slice(1)) {
      expect(await client(0).balanceOf(wallet.id)).toBe('60.00');
      expect(await client(0).ledgerOf(wallet.id)).toHaveLength(21);
    }

    const newEvents = [...(await cluster.sql`SELECT id FROM outbox_messages`)]
      .map((row) => row.id as string)
      .filter((id) => !knownEvents.has(id));
    expect(newEvents).toHaveLength(120 * 2 + 3);
    const delivered = await drainEventIds();
    expect(delivered).toHaveLength(newEvents.length);
    expect(new Set(delivered)).toEqual(new Set(newEvents));

    await expectReconciled(orphanWallet, '62.00', 1);
  });
});
