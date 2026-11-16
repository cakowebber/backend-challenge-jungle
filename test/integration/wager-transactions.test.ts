import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MetricName } from '../../src/application/ports/observability';
import { startTestApp, type TestApp, type WalletJson } from '../support/test-app';

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp('wager_transactions');
});

afterAll(async () => {
  await app.close();
});

const BRL = (amount: string) => ({ amount, currency: 'BRL' });

async function transactionsOf(walletId: string): Promise<number> {
  const [row] = await app.sql`
    SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ${walletId} AND kind <> 'OPENING'`;
  return row.n as number;
}

async function placedBet(wallet: WalletJson, amount: string) {
  const payload = app.payload(wallet, 'BET', amount);
  const response = await app.submit(payload);
  expect(response.status).toBe(201);
  return { payload, response };
}

describe('POST /wagering/transactions — operações', () => {
  test('BET: 201 PROCESSED, debita o saldo e responde no formato do contrato', async () => {
    const wallet = await app.createWallet('1000.00');

    const response = await app.submit(app.payload(wallet, 'BET', '25.00'));

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'PROCESSED',
      balance: BRL('975.00'),
      idempotentReplay: false,
    });
    expect(await app.balanceOf(wallet.id)).toBe('975.00');
    const ledger = await app.ledgerOf(wallet.id);
    expect(ledger.map(({ direction, amount, balance_after }) => ({ direction, amount, balance_after }))).toEqual([
      { direction: 'CREDIT', amount: '1000.00', balance_after: '1000.00' },
      { direction: 'DEBIT', amount: '25.00', balance_after: '975.00' },
    ]);
    expect(ledger[1]?.transaction_id).toBe(response.body.transactionId);
  });

  test('BET sem saldo: 422 REJECTED com failureCode, sem alterar saldo nem ledger', async () => {
    const wallet = await app.createWallet('20.00');

    const response = await app.submit(app.payload(wallet, 'BET', '20.01'));

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: BRL('20.00'),
      idempotentReplay: false,
    });
    expect(await app.balanceOf(wallet.id)).toBe('20.00');
    expect(await app.ledgerOf(wallet.id)).toHaveLength(1);
    expect(await transactionsOf(wallet.id)).toBe(1);
  });

  test('BET do saldo inteiro: o saldo zero volta como "0.00", com a escala preservada', async () => {
    const wallet = await app.createWallet('25.00');

    const response = await app.submit(app.payload(wallet, 'BET', '25.00'));

    expect(response.body.balance).toEqual(BRL('0.00'));
    expect((await app.get(`/wallets/${wallet.id}`)).body.balance).toEqual(BRL('0.00'));
  });

  test('WIN: 201 e credita', async () => {
    const wallet = await app.createWallet('100.00');

    const response = await app.submit(app.payload(wallet, 'WIN', '50.50'));

    expect(response.status).toBe(201);
    expect(response.body.balance).toEqual(BRL('150.50'));
    expect((await app.ledgerOf(wallet.id)).at(-1)).toMatchObject({ direction: 'CREDIT', amount: '50.50' });
  });

  test('LOSS: 201 PROCESSED sem mover saldo, sem lançamento e sem mudar a versão', async () => {
    const wallet = await app.createWallet('100.00');

    const response = await app.submit(app.payload(wallet, 'LOSS', '25.00'));

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'PROCESSED', balance: BRL('100.00') });
    expect(await app.ledgerOf(wallet.id)).toHaveLength(1);
    expect((await app.get(`/wallets/${wallet.id}`)).body.version).toBe(1);
  });

  test('REFUND devolve a aposta uma única vez; o segundo é rejeitado', async () => {
    const wallet = await app.createWallet('100.00');
    const { payload: bet, response: betResponse } = await placedBet(wallet, '40.00');
    const refund = () =>
      app.submit(app.payload(wallet, 'REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId }));

    const first = await refund();
    const second = await refund();

    expect(first.status).toBe(201);
    expect(first.body.balance).toEqual(BRL('100.00'));
    expect(second.status).toBe(422);
    expect(second.body).toMatchObject({ failureCode: 'REFERENCE_ALREADY_REVERSED', balance: BRL('100.00') });
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
    const stored = await app.get(`/wagering/transactions/${first.body.transactionId}`);
    expect(stored.body.referenceTransactionId).toBe(betResponse.body.transactionId);
  });

  test('ROLLBACK depois de um REFUND da mesma BET também é rejeitado (uma reversão por referência)', async () => {
    const wallet = await app.createWallet('100.00');
    const { payload: bet } = await placedBet(wallet, '40.00');
    const reference = { referenceExternalTransactionId: bet.externalTransactionId };
    await app.submit(app.payload(wallet, 'REFUND', '40.00', reference));

    const rollback = await app.submit(app.payload(wallet, 'ROLLBACK', '40.00', reference));

    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
  });

  test('ROLLBACK de WIN debita; se negativaria o saldo, é rejeitado com código próprio', async () => {
    const wallet = await app.createWallet('10.00');
    const win = app.payload(wallet, 'WIN', '50.00');
    await app.submit(win);
    await placedBet(wallet, '55.00');

    const rollback = await app.submit(
      app.payload(wallet, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }),
    );

    expect(rollback.status).toBe(422);
    expect(rollback.body).toMatchObject({ failureCode: 'REVERSAL_WOULD_OVERDRAW', balance: BRL('5.00') });
    expect(await app.balanceOf(wallet.id)).toBe('5.00');
  });

  test('REFUND com valor diferente da aposta é rejeitado', async () => {
    const wallet = await app.createWallet('100.00');
    const { payload: bet } = await placedBet(wallet, '40.00');

    const refund = await app.submit(
      app.payload(wallet, 'REFUND', '39.99', { referenceExternalTransactionId: bet.externalTransactionId }),
    );

    expect(refund.status).toBe(422);
    expect(refund.body.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
  });

  test('REFUND antes da BET: 202 PENDING_REFERENCE, sem tocar no saldo', async () => {
    const wallet = await app.createWallet('100.00');

    const refund = await app.submit(
      app.payload(wallet, 'REFUND', '40.00', { referenceExternalTransactionId: 'bet-que-ainda-nao-chegou' }),
    );

    expect(refund.status).toBe(202);
    expect(refund.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: BRL('100.00') });
    expect(refund.body.failureCode).toBeUndefined();
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
    expect(await app.eventsOf(refund.body.transactionId)).toEqual(['WagerTransactionPendingReference']);
  });

  test('moeda diferente da wallet: 422 CURRENCY_MISMATCH, com o saldo observado na moeda da wallet', async () => {
    const wallet = await app.createWallet('100.00');

    const response = await app.submit(
      app.payload(wallet, 'BET', '25.00', { money: { amount: '25.00', currency: 'USD' } }),
    );

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ failureCode: 'CURRENCY_MISMATCH', balance: BRL('100.00') });
    const stored = await app.get(`/wagering/transactions/${response.body.transactionId}`);
    expect(stored.body.money).toEqual({ amount: '25.00', currency: 'USD' });
    expect(stored.body.balance).toEqual(BRL('100.00'));
  });

  test('wallet de outro player: 422 PLAYER_WALLET_MISMATCH', async () => {
    const wallet = await app.createWallet('100.00');

    const response = await app.submit(app.payload(wallet, 'BET', '25.00', { playerId: 'outro-player' }));

    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('PLAYER_WALLET_MISMATCH');
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
  });

  test('wallet inexistente: 422 WALLET_NOT_FOUND e nada é gravado', async () => {
    const ghost = { id: Bun.randomUUIDv7(), playerId: 'player-x', balance: BRL('0.00'), version: 1 };
    const payload = app.payload(ghost, 'BET', '25.00');

    const response = await app.submit(payload);

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'WALLET_NOT_FOUND', failureCode: 'WALLET_NOT_FOUND' });
    const [row] = await app.sql`
      SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id = ${payload.externalTransactionId}`;
    expect(row.n).toBe(0);
  });
});

describe('POST /wagering/transactions — idempotência', () => {
  test('replay devolve o mesmo status e corpo, com o saldo ORIGINAL e idempotentReplay: true', async () => {
    const wallet = await app.createWallet('1000.00');
    const payload = app.payload(wallet, 'BET', '25.00');

    const original = await app.submit(payload);
    await placedBet(wallet, '100.00');
    const replay = await app.submit(payload);

    expect(original.body.balance).toEqual(BRL('975.00'));
    expect(replay.status).toBe(original.status);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual(BRL('975.00'));
    expect(await app.balanceOf(wallet.id)).toBe('875.00');
    expect(await transactionsOf(wallet.id)).toBe(2);
  });

  test('replay de transação rejeitada devolve a mesma rejeição, mesmo que agora houvesse saldo', async () => {
    const wallet = await app.createWallet('10.00');
    const payload = app.payload(wallet, 'BET', '50.00');

    const original = await app.submit(payload);
    await app.submit(app.payload(wallet, 'WIN', '500.00'));
    const replay = await app.submit(payload);

    expect(original.status).toBe(422);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', balance: BRL('10.00') });
    expect(await app.balanceOf(wallet.id)).toBe('510.00');
  });

  test('replay de transação aguardando referência repete o 202', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'ROLLBACK', '10.00', { referenceExternalTransactionId: 'nao-chegou' });

    const original = await app.submit(payload);
    const replay = await app.submit(payload);

    expect(original.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
  });

  test('o mesmo payload com as chaves em outra ordem ainda é replay', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '25.00');
    const key = { 'idempotency-key': `provider-a:${payload.externalTransactionId}` };
    await app.post('/wagering/transactions', payload, key);

    const reordered = JSON.stringify(Object.fromEntries(Object.entries(payload).reverse()), null, 4);
    const replay = await app.post('/wagering/transactions', reordered, key);

    expect(replay.status).toBe(201);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(await app.balanceOf(wallet.id)).toBe('75.00');
  });

  test('mesma key com payload divergente: 409, e nada muda', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '25.00');
    const key = `provider-a:${payload.externalTransactionId}`;
    await app.submit(payload, key);

    const divergent = await app.submit({ ...payload, money: BRL('26.00') }, key);

    expect(divergent.status).toBe(409);
    expect(divergent.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(divergent.body.idempotentReplay).toBeUndefined();
    expect(await app.balanceOf(wallet.id)).toBe('75.00');
    expect(await transactionsOf(wallet.id)).toBe(1);
  });

  test.each([
    ['kind', { kind: 'WIN' }],
    ['rodada', { roundId: 'outra-rodada' }],
    ['jogo', { gameId: 'outro-jogo' }],
  ])('divergência em %s também é conflito', async (_campo, change) => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '25.00');
    const key = `provider-a:${payload.externalTransactionId}`;
    await app.submit(payload, key);

    const divergent = await app.submit({ ...payload, ...change }, key);

    expect(divergent.status).toBe(409);
    expect(await app.balanceOf(wallet.id)).toBe('75.00');
  });

  test('mesma operação do provedor com OUTRA key: 409, sem segundo débito', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '25.00');
    await app.submit(payload, 'key-original');

    const again = await app.submit(payload, 'key-diferente');

    expect(again.status).toBe(409);
    expect(again.body.code).toBe('EXTERNAL_TRANSACTION_ID_CONFLICT');
    expect(await app.balanceOf(wallet.id)).toBe('75.00');
  });

  test('duplicatas são contadas em métrica', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '1.00');
    const before = app.metrics.value(MetricName.DuplicatesDetected);

    await app.submit(payload);
    await app.submit(payload);
    await app.submit(payload);

    expect(app.metrics.value(MetricName.DuplicatesDetected)).toBe(before + 2);
  });
});

describe('POST /wagering/transactions — payload inválido (400)', () => {
  let wallet: WalletJson;

  beforeAll(async () => {
    wallet = await app.createWallet('100.00');
  });

  const cases: [string, (base: Record<string, unknown>) => unknown, string][] = [
    ['amount sem casas decimais', (p) => ({ ...p, money: BRL('25') }), 'money'],
    ['amount com 1 casa', (p) => ({ ...p, money: BRL('25.5') }), 'money'],
    ['amount com 3 casas', (p) => ({ ...p, money: BRL('25.123') }), 'money'],
    ['amount como number', (p) => ({ ...p, money: { amount: 25, currency: 'BRL' } }), 'money'],
    ['amount negativo', (p) => ({ ...p, money: BRL('-5.00') }), 'money'],
    ['amount em notação científica', (p) => ({ ...p, money: BRL('1e2') }), 'money'],
    ['amount vazio', (p) => ({ ...p, money: BRL('') }), 'money'],
    ['moeda minúscula', (p) => ({ ...p, money: { amount: '25.00', currency: 'brl' } }), 'money'],
    ['money ausente', ({ money: _omitido, ...rest }) => rest, 'money'],
    ['BET de valor zero', (p) => ({ ...p, money: BRL('0.00') }), 'money'],
    ['kind OPENING (interno)', (p) => ({ ...p, kind: 'OPENING' }), 'kind'],
    ['kind desconhecido', (p) => ({ ...p, kind: 'CASHBACK' }), 'kind'],
    ['REFUND sem referência', (p) => ({ ...p, kind: 'REFUND' }), 'referenceExternalTransactionId'],
    ['ROLLBACK sem referência', (p) => ({ ...p, kind: 'ROLLBACK' }), 'referenceExternalTransactionId'],
    ['BET com referência', (p) => ({ ...p, referenceExternalTransactionId: 'x' }), 'referenceExternalTransactionId'],
    ['walletId que não é UUID', (p) => ({ ...p, walletId: 'wallet-1' }), 'walletId'],
    ['providerId ausente', ({ providerId: _omitido, ...rest }) => rest, 'providerId'],
    ['externalTransactionId vazio', (p) => ({ ...p, externalTransactionId: '  ' }), 'externalTransactionId'],
    ['roundId como number', (p) => ({ ...p, roundId: 987 }), 'roundId'],
    ['corpo que não é objeto', () => ['nao', 'e', 'objeto'], 'body'],
  ];

  test.each(cases)('%s', async (_caso, mutate, field) => {
    const base = app.payload(wallet, 'BET', '25.00') as unknown as Record<string, unknown>;

    const response = await app.post('/wagering/transactions', mutate(base), { 'idempotency-key': Bun.randomUUIDv7() });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_PAYLOAD');
    expect(response.body.details.map((d: { field: string }) => d.field)).toContain(field);
  });

  test('sem o header Idempotency-Key', async () => {
    const response = await app.post('/wagering/transactions', app.payload(wallet, 'BET', '25.00'));

    expect(response.status).toBe(400);
    expect(response.body.details).toEqual([{ field: 'Idempotency-Key', message: 'é obrigatório' }]);
  });

  test('JSON malformado', async () => {
    const response = await app.post('/wagering/transactions', '{ "kind": ', { 'idempotency-key': 'k' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_PAYLOAD');
  });

  test('todos os problemas são listados de uma vez', async () => {
    const response = await app.post('/wagering/transactions', { kind: 'NADA' }, { 'idempotency-key': 'k' });

    const fields = response.body.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(
      expect.arrayContaining(['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'money', 'kind']),
    );
  });

  test('nenhuma requisição inválida deixou registro ou alterou o saldo', async () => {
    expect(await transactionsOf(wallet.id)).toBe(0);
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
  });
});

describe('atomicidade: wallet, ledger, transação e outbox na mesma transação SQL', () => {
  test('transação aplicada grava os eventos junto: Processed + BalanceChanged', async () => {
    const wallet = await app.createWallet('100.00');

    const bet = await app.submit(app.payload(wallet, 'BET', '25.00'));

    expect(await app.eventsOf(bet.body.transactionId)).toEqual(['WagerTransactionProcessed']);
    const [event] = await app.sql`
      SELECT payload, published_at FROM outbox_messages
       WHERE event_type = 'WalletBalanceChanged' AND payload->'data'->>'transactionId' = ${bet.body.transactionId}`;
    expect(event.published_at).toBeNull();
    expect(event.payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: wallet.id,
      data: {
        direction: 'DEBIT',
        money: BRL('25.00'),
        balanceBefore: BRL('100.00'),
        balanceAfter: BRL('75.00'),
        walletVersion: 2,
      },
    });
  });

  test('rejeição grava só WagerTransactionRejected; LOSS grava só Processed', async () => {
    const wallet = await app.createWallet('10.00');

    const rejected = await app.submit(app.payload(wallet, 'BET', '50.00'));
    const loss = await app.submit(app.payload(wallet, 'LOSS', '5.00'));

    expect(await app.eventsOf(rejected.body.transactionId)).toEqual(['WagerTransactionRejected']);
    expect(await app.eventsOf(loss.body.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await app.eventsOf(wallet.id)).toEqual(['WalletBalanceChanged']);
  });

  test('o correlationId do chamador chega aos eventos e volta no header', async () => {
    const wallet = await app.createWallet('100.00');

    const bet = await app.post('/wagering/transactions', app.payload(wallet, 'BET', '1.00'), {
      'idempotency-key': Bun.randomUUIDv7(),
      'x-correlation-id': 'corr-do-provedor-42',
    });

    expect(bet.headers.get('x-correlation-id')).toBe('corr-do-provedor-42');
    const [event] = await app.sql`SELECT payload FROM outbox_messages WHERE aggregate_id = ${bet.body.transactionId}`;
    expect(event.payload.correlationId).toBe('corr-do-provedor-42');
  });

  test('falha no meio (gravação da outbox): NADA fica gravado, e o reenvio processa uma única vez', async () => {
    await app.sql.unsafe(`
      CREATE FUNCTION test_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.payload->>'correlationId' = 'falhar-na-outbox' THEN
          RAISE EXCEPTION 'falha injetada pelo teste';
        END IF;
        RETURN NEW;
      END $$`);
    await app.sql.unsafe(`
      CREATE TRIGGER test_fail_outbox BEFORE INSERT ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION test_fail_outbox()`);

    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '25.00');
    const key = `provider-a:${payload.externalTransactionId}`;

    const failed = await app.post('/wagering/transactions', payload, {
      'idempotency-key': key,
      'x-correlation-id': 'falhar-na-outbox',
    });

    expect(failed.status).toBe(500);
    expect(failed.body.code).toBe('INTERNAL_ERROR');
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
    expect(await app.ledgerOf(wallet.id)).toHaveLength(1);
    expect(await transactionsOf(wallet.id)).toBe(0);
    expect((await app.get(`/wallets/${wallet.id}`)).body.version).toBe(1);

    const retry = await app.submit(payload, key);
    expect(retry.status).toBe(201);
    expect(retry.body.idempotentReplay).toBe(false);
    expect(await app.balanceOf(wallet.id)).toBe('75.00');
    expect(await app.ledgerMatchesBalance(wallet.id)).toBe(true);
  });
});

describe('consultas de transação', () => {
  test('GET /wagering/transactions/:id devolve a transação gravada', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '25.00');
    const submitted = await app.submit(payload);

    const response = await app.get(`/wagering/transactions/${submitted.body.transactionId}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      transactionId: submitted.body.transactionId,
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      idempotencyKey: `provider-a:${payload.externalTransactionId}`,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: BRL('25.00'),
      status: 'PROCESSED',
      failureCode: null,
      balance: BRL('75.00'),
    });
    expect(new Date(response.body.processedAt).getTime()).not.toBeNaN();
  });

  test('GET /providers/:providerId/wagering/transactions/:externalTransactionId', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '25.00');
    const submitted = await app.submit(payload);

    const response = await app.get(
      `/providers/${payload.providerId}/wagering/transactions/${payload.externalTransactionId}`,
    );
    const otherProvider = await app.get(`/providers/provider-z/wagering/transactions/${payload.externalTransactionId}`);

    expect(response.status).toBe(200);
    expect(response.body.transactionId).toBe(submitted.body.transactionId);
    expect(otherProvider.status).toBe(404);
  });

  test('transação inexistente: 404; id malformado: 400', async () => {
    const missing = await app.get(`/wagering/transactions/${Bun.randomUUIDv7()}`);
    const malformed = await app.get('/wagering/transactions/nao-e-uuid');

    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('INVALID_PAYLOAD');
  });
});
