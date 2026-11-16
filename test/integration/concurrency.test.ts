import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startTestApp, type HttpResult, type TestApp, type WalletJson } from '../support/test-app';

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp('concurrency');
});

afterAll(async () => {
  await app.close();
});

const BRL = (amount: string) => ({ amount, currency: 'BRL' });
const countBy = (results: HttpResult[], status: number) => results.filter((r) => r.status === status).length;

async function debitsOf(walletId: string) {
  return (await app.ledgerOf(walletId)).filter((entry) => entry.direction === 'DEBIT');
}

async function expectUnbrokenLedgerChain(wallet: WalletJson) {
  const ledger = await app.ledgerOf(wallet.id);
  for (let i = 1; i < ledger.length; i++) {
    expect(ledger[i]?.balance_before).toBe(ledger[i - 1]?.balance_after as string);
  }
  expect(ledger.at(-1)?.balance_after).toBe(await app.balanceOf(wallet.id));
  expect(await app.ledgerMatchesBalance(wallet.id)).toBe(true);
}

describe('cenário obrigatório (desafio 8): 100.00 e duas apostas de 80.00 simultâneas', () => {
  test('uma PROCESSED, a outra REJECTED por saldo, saldo final 20.00 e um único débito', async () => {
    const wallet = await app.createWallet('100.00');

    const results = await Promise.all([
      app.submit(app.payload(wallet, 'BET', '80.00')),
      app.submit(app.payload(wallet, 'BET', '80.00')),
    ]);

    const processed = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 422);
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(processed[0]?.body).toMatchObject({ status: 'PROCESSED', balance: BRL('20.00') });
    expect(rejected[0]?.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: BRL('20.00'),
    });
    expect(await app.balanceOf(wallet.id)).toBe('20.00');
    expect(await debitsOf(wallet.id)).toHaveLength(1);
    await expectUnbrokenLedgerChain(wallet);
  });

  test('o resultado é o mesmo em 30 wallets disputadas ao mesmo tempo', async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, () => app.createWallet('100.00')));

    const rounds = await Promise.all(
      wallets.map((wallet) =>
        Promise.all([
          app.submit(app.payload(wallet, 'BET', '80.00')),
          app.submit(app.payload(wallet, 'BET', '80.00')),
        ]),
      ),
    );

    for (const [index, results] of rounds.entries()) {
      const wallet = wallets[index] as WalletJson;
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(await app.balanceOf(wallet.id)).toBe('20.00');
      expect(await debitsOf(wallet.id)).toHaveLength(1);
    }
  });

  test('reenviar as duas apostas depois não duplica o débito', async () => {
    const wallet = await app.createWallet('100.00');
    const bets = [app.payload(wallet, 'BET', '80.00'), app.payload(wallet, 'BET', '80.00')];
    const first = await Promise.all(bets.map((bet) => app.submit(bet)));

    const retries = await Promise.all([...bets, ...bets, ...bets].map((bet) => app.submit(bet)));

    expect(retries.every((r) => r.body.idempotentReplay === true)).toBe(true);
    expect(countBy(retries, 201)).toBe(3);
    expect(countBy(retries, 422)).toBe(3);
    for (const [index, retry] of retries.entries()) {
      expect(retry.body.transactionId).toBe(first[index % 2]?.body.transactionId);
    }
    expect(await app.balanceOf(wallet.id)).toBe('20.00');
    expect(await debitsOf(wallet.id)).toHaveLength(1);
  });
});

describe('a mesma aposta enviada 50 vezes em paralelo', () => {
  test('um único débito, uma única transação, e as 50 respostas contam a mesma história', async () => {
    const wallet = await app.createWallet('1000.00');
    const payload = app.payload(wallet, 'BET', '25.00');

    const results = await Promise.all(Array.from({ length: 50 }, () => app.submit(payload)));

    expect(countBy(results, 201)).toBe(50);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.every((r) => r.body.balance.amount === '975.00')).toBe(true);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter((r) => r.body.idempotentReplay === true)).toHaveLength(49);

    expect(await app.balanceOf(wallet.id)).toBe('975.00');
    expect(await debitsOf(wallet.id)).toHaveLength(1);
    const [row] = await app.sql`
      SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id = ${payload.externalTransactionId}`;
    expect(row.n).toBe(1);
    const transactionId = results[0]?.body.transactionId as string;
    expect(await app.eventsOf(transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await app.eventsOf(wallet.id)).toEqual(['WalletBalanceChanged', 'WalletBalanceChanged']);
    await expectUnbrokenLedgerChain(wallet);
  });

  test('50 vezes uma aposta que será rejeitada: uma rejeição gravada, 50 respostas iguais', async () => {
    const wallet = await app.createWallet('10.00');
    const payload = app.payload(wallet, 'BET', '25.00');

    const results = await Promise.all(Array.from({ length: 50 }, () => app.submit(payload)));

    expect(countBy(results, 422)).toBe(50);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.every((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(await app.balanceOf(wallet.id)).toBe('10.00');
  });

  test('mesma key em paralelo com payloads diferentes: uma processa, as outras são conflito', async () => {
    const wallet = await app.createWallet('1000.00');
    const base = app.payload(wallet, 'BET', '10.00');
    const key = `provider-a:${base.externalTransactionId}`;

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => app.submit({ ...base, money: BRL(`${10 + i}.00`) }, key)),
    );

    expect(countBy(results, 201)).toBe(1);
    expect(countBy(results, 409)).toBe(19);
    expect(await debitsOf(wallet.id)).toHaveLength(1);
    await expectUnbrokenLedgerChain(wallet);
  });

  test('mesma key em paralelo para wallets DIFERENTES: só uma wallet é debitada', async () => {
    const [a, b] = await Promise.all([app.createWallet('100.00'), app.createWallet('100.00')]);
    const forA = app.payload(a as WalletJson, 'BET', '30.00');
    const forB = { ...app.payload(b as WalletJson, 'BET', '30.00'), externalTransactionId: forA.externalTransactionId };
    const key = `provider-a:${forA.externalTransactionId}`;

    const results = await Promise.all([app.submit(forA, key), app.submit(forB, key)]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const balances = [await app.balanceOf((a as WalletJson).id), await app.balanceOf((b as WalletJson).id)].sort();
    expect(balances).toEqual(['100.00', '70.00']);
  });
});

describe('wallet disputada por muitas operações diferentes', () => {
  test('30 apostas de 10.00 sobre 100.00: exatamente 10 passam e o saldo zera, sem negativar', async () => {
    const wallet = await app.createWallet('100.00');

    const results = await Promise.all(
      Array.from({ length: 30 }, () => app.submit(app.payload(wallet, 'BET', '10.00'))),
    );

    expect(countBy(results, 201)).toBe(10);
    expect(countBy(results, 422)).toBe(20);
    expect(results.filter((r) => r.status === 422).every((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(await app.balanceOf(wallet.id)).toBe('0.00');
    expect(await debitsOf(wallet.id)).toHaveLength(10);
    const observed = results.filter((r) => r.status === 201).map((r) => r.body.balance.amount).sort();
    expect(new Set(observed).size).toBe(10);
    expect((await app.get(`/wallets/${wallet.id}`)).body.version).toBe(11);
    await expectUnbrokenLedgerChain(wallet);
  });

  test('créditos e débitos misturados: nenhum se perde', async () => {
    const wallet = await app.createWallet('100.00');

    const results = await Promise.all([
      ...Array.from({ length: 20 }, () => app.submit(app.payload(wallet, 'WIN', '5.00'))),
      ...Array.from({ length: 20 }, () => app.submit(app.payload(wallet, 'BET', '5.00'))),
    ]);

    expect(countBy(results, 201)).toBe(40);
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
    expect(await app.ledgerOf(wallet.id)).toHaveLength(41);
    expect((await app.get(`/wallets/${wallet.id}`)).body.version).toBe(41);
    await expectUnbrokenLedgerChain(wallet);
  });

  test('REFUND e ROLLBACK simultâneos da mesma aposta: ela é revertida uma única vez', async () => {
    const wallet = await app.createWallet('100.00');
    const bet = app.payload(wallet, 'BET', '40.00');
    await app.submit(bet);
    const reference = { referenceExternalTransactionId: bet.externalTransactionId };

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        app.submit(app.payload(wallet, i % 2 === 0 ? 'REFUND' : 'ROLLBACK', '40.00', reference)),
      ),
    );

    expect(countBy(results, 201)).toBe(1);
    expect(countBy(results, 422)).toBe(9);
    expect(results.filter((r) => r.status === 422).every((r) => r.body.failureCode === 'REFERENCE_ALREADY_REVERSED')).toBe(true);
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
    await expectUnbrokenLedgerChain(wallet);
  });
});

describe('wallets distintas em paralelo', () => {
  test('20 wallets x 5 apostas cada, tudo ao mesmo tempo: cada wallet fecha a própria conta', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => app.createWallet('100.00')));

    const results = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () => app.submit(app.payload(wallet, 'BET', '10.00'))),
      ),
    );

    expect(countBy(results, 201)).toBe(100);
    for (const wallet of wallets) {
      expect(await app.balanceOf(wallet.id)).toBe('50.00');
      expect(await debitsOf(wallet.id)).toHaveLength(5);
      await expectUnbrokenLedgerChain(wallet);
    }
  });

  test('uma wallet travada não atrasa as outras (o lock é por linha, não global)', async () => {
    const [blocked, free] = await Promise.all([app.createWallet('100.00'), app.createWallet('100.00')]);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));

    const holder = app.sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${(blocked as WalletJson).id} FOR UPDATE`;
      locked();
      await released;
    });
    await lockTaken;

    const started = performance.now();
    const onFree = await app.submit(app.payload(free as WalletJson, 'BET', '10.00'));
    const elapsed = performance.now() - started;

    const onBlocked = app.submit(app.payload(blocked as WalletJson, 'BET', '10.00'));
    const stillWaiting = await Promise.race([onBlocked.then(() => false), Bun.sleep(300).then(() => true)]);

    release();
    await holder;

    expect(onFree.status).toBe(201);
    expect(elapsed).toBeLessThan(1000);
    expect(stillWaiting).toBe(true);
    expect((await onBlocked).status).toBe(201);
  });
});

describe('criação de wallet concorrente', () => {
  test('10 criações simultâneas para o mesmo player: uma wallet, um crédito de abertura', async () => {
    const playerId = Bun.randomUUIDv7();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => app.post('/wallets', { playerId, initialBalance: BRL('100.00') })),
    );

    expect(countBy(results, 201)).toBe(1);
    expect(countBy(results, 409)).toBe(9);
    const rows = await app.sql`SELECT id FROM wallets WHERE player_id = ${playerId}`;
    expect(rows).toHaveLength(1);
    expect(await app.ledgerOf(rows[0].id)).toHaveLength(1);
  });
});

describe('espera pelo lock tem limite', () => {
  let impatient: TestApp;

  beforeAll(async () => {
    impatient = await startTestApp('concurrency_lock_timeout', { databaseLockTimeoutMs: 300 });
  });

  afterAll(async () => {
    await impatient.close();
  });

  test('lock que não vem a tempo: 503 com Retry-After, nada gravado, e o reenvio da mesma key funciona', async () => {
    const wallet = await impatient.createWallet('100.00');
    const payload = impatient.payload(wallet, 'BET', '25.00');
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));

    const holder = impatient.sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      locked();
      await released;
    });
    await lockTaken;

    const blocked = await impatient.submit(payload);

    expect(blocked.status).toBe(503);
    expect(blocked.body.code).toBe('TRANSIENT_FAILURE');
    expect(blocked.headers.get('retry-after')).toBe('1');
    const [row] = await impatient.sql`
      SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id = ${payload.externalTransactionId}`;
    expect(row.n).toBe(0);

    release();
    await holder;

    const retry = await impatient.submit(payload);
    expect(retry.status).toBe(201);
    expect(retry.body.idempotentReplay).toBe(false);
    expect(await impatient.balanceOf(wallet.id)).toBe('75.00');
  });
});
