import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MetricName } from '../../src/application/ports/observability';
import { startTestApp, type TestApp } from '../support/test-app';

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp('wallets');
});

afterAll(async () => {
  await app.close();
});

const BRL = (amount: string) => ({ amount, currency: 'BRL' });

describe('POST /wallets', () => {
  test('201 com o contrato do desafio: saldo inicial e version 1', async () => {
    const playerId = Bun.randomUUIDv7();

    const response = await app.post('/wallets', { playerId, initialBalance: BRL('1000.00') });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      playerId,
      balance: BRL('1000.00'),
      version: 1,
    });
  });

  test('saldo inicial gera a transação OPENING e o lançamento CREDIT na mesma transação SQL', async () => {
    const wallet = await app.createWallet('1000.00');

    const [opening] = await app.sql`
      SELECT id, kind, status, amount::text, provider_id, external_transaction_id, xmin::text AS tx
        FROM wager_transactions WHERE wallet_id = ${wallet.id}`;
    const [entry] = await app.sql`
      SELECT transaction_id, direction, amount::text, balance_before::text, balance_after::text, xmin::text AS tx
        FROM wallet_ledger_entries WHERE wallet_id = ${wallet.id}`;
    const [row] = await app.sql`SELECT xmin::text AS tx FROM wallets WHERE id = ${wallet.id}`;

    expect(opening).toMatchObject({
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '1000.00',
      provider_id: 'internal',
      external_transaction_id: `opening:${wallet.id}`,
    });
    expect(entry).toMatchObject({
      transaction_id: opening.id,
      direction: 'CREDIT',
      amount: '1000.00',
      balance_before: '0.00',
      balance_after: '1000.00',
    });
    // xmin é o id da transação do Postgres que gravou cada linha: as três vieram da mesma.
    expect(opening.tx).toBe(row.tx);
    expect(entry.tx).toBe(row.tx);
    expect(await app.eventsOf(wallet.id)).toEqual(['WalletBalanceChanged']);
    expect(await app.eventsOf(opening.id)).toEqual(['WagerTransactionProcessed']);
    expect(await app.ledgerMatchesBalance(wallet.id)).toBe(true);
  });

  test('wallet zerada: sem OPENING, sem lançamento, sem evento, e "0.00" com escala', async () => {
    const wallet = await app.createWallet('0.00');

    expect(wallet.balance).toEqual(BRL('0.00'));
    expect(wallet.version).toBe(1);
    expect(await app.ledgerOf(wallet.id)).toEqual([]);
    expect(await app.eventsOf(wallet.id)).toEqual([]);
    const [row] = await app.sql`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ${wallet.id}`;
    expect(row.n).toBe(0);
  });

  test('wallet duplicada para o mesmo player e moeda: 409, sem segundo crédito de abertura', async () => {
    const playerId = Bun.randomUUIDv7();
    const first = await app.post('/wallets', { playerId, initialBalance: BRL('100.00') });

    const second = await app.post('/wallets', { playerId, initialBalance: BRL('999.00') });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('WALLET_ALREADY_EXISTS');
    const [row] = await app.sql`SELECT count(*)::int AS n FROM wallets WHERE player_id = ${playerId}`;
    expect(row.n).toBe(1);
    expect(await app.balanceOf(first.body.id)).toBe('100.00');
  });

  test('o mesmo player pode ter wallet em outra moeda', async () => {
    const playerId = Bun.randomUUIDv7();
    await app.post('/wallets', { playerId, initialBalance: BRL('100.00') });

    const usd = await app.post('/wallets', { playerId, initialBalance: { amount: '50.00', currency: 'USD' } });

    expect(usd.status).toBe(201);
    expect(usd.body.balance).toEqual({ amount: '50.00', currency: 'USD' });
  });

  test.each([
    ['playerId ausente', { initialBalance: BRL('1.00') }, 'playerId'],
    ['playerId vazio', { playerId: ' ', initialBalance: BRL('1.00') }, 'playerId'],
    ['saldo ausente', { playerId: 'p' }, 'initialBalance'],
    ['saldo como number', { playerId: 'p', initialBalance: { amount: 1000, currency: 'BRL' } }, 'initialBalance'],
    ['saldo negativo', { playerId: 'p', initialBalance: BRL('-1.00') }, 'initialBalance'],
    ['saldo sem 2 casas', { playerId: 'p', initialBalance: BRL('1000') }, 'initialBalance'],
    ['moeda inválida', { playerId: 'p', initialBalance: { amount: '1.00', currency: 'REAL' } }, 'initialBalance'],
  ])('400: %s', async (_caso, body, field) => {
    const response = await app.post('/wallets', body);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_PAYLOAD');
    expect(response.body.details.map((d: { field: string }) => d.field)).toContain(field);
  });
});

describe('GET /wallets/:walletId', () => {
  test('devolve saldo e versão atuais', async () => {
    const wallet = await app.createWallet('100.00');
    await app.submit(app.payload(wallet, 'BET', '30.00'));

    const response = await app.get(`/wallets/${wallet.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: wallet.id, playerId: wallet.playerId, balance: BRL('70.00'), version: 2 });
  });

  test('inexistente: 404; id malformado: 400', async () => {
    expect((await app.get(`/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await app.get('/wallets/abc')).status).toBe(400);
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  /** Wallet com 6 lançamentos: abertura de 100.00 e cinco apostas de 10.00. */
  async function walletWithHistory() {
    const wallet = await app.createWallet('100.00');
    for (let i = 0; i < 5; i++) {
      await app.submit(app.payload(wallet, 'BET', '10.00'));
    }
    return wallet;
  }

  const after = (items: { balanceAfter: { amount: string } }[]) => items.map((item) => item.balanceAfter.amount);

  test('lista os lançamentos em ordem de gravação, no formato do contrato', async () => {
    const wallet = await walletWithHistory();

    const response = await app.get(`/wallets/${wallet.id}/ledger`);

    expect(response.status).toBe(200);
    expect(after(response.body.items)).toEqual(['100.00', '90.00', '80.00', '70.00', '60.00', '50.00']);
    expect(response.body.nextCursor).toBeNull();
    expect(response.body.items[1]).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: 'DEBIT',
      money: BRL('10.00'),
      balanceBefore: BRL('100.00'),
      balanceAfter: BRL('90.00'),
      createdAt: expect.any(String),
    });
  });

  test('pagina com cursor opaco, sem repetir nem pular lançamentos', async () => {
    const wallet = await walletWithHistory();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query: string = cursor === null ? 'limit=2' : `limit=2&cursor=${cursor}`;
      const page = await app.get(`/wallets/${wallet.id}/ledger?${query}`);
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...after(page.body.items));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toEqual(['100.00', '90.00', '80.00', '70.00', '60.00', '50.00']);
  });

  test('o cursor é estável: lançamentos novos só aparecem depois dele', async () => {
    const wallet = await walletWithHistory();
    const first = await app.get(`/wallets/${wallet.id}/ledger?limit=4`);
    const cursor = first.body.nextCursor as string;

    await app.submit(app.payload(wallet, 'WIN', '5.00')); // chega um lançamento novo entre as páginas
    const second = await app.get(`/wallets/${wallet.id}/ledger?limit=4&cursor=${cursor}`);
    const firstAgain = await app.get(`/wallets/${wallet.id}/ledger?limit=4`);

    expect(after(first.body.items)).toEqual(['100.00', '90.00', '80.00', '70.00']);
    expect(after(second.body.items)).toEqual(['60.00', '50.00', '55.00']);
    expect(after(firstAgain.body.items)).toEqual(after(first.body.items)); // a página já lida não muda
  });

  test('o cursor não expõe a posição interna em texto claro', async () => {
    const wallet = await walletWithHistory();

    const page = await app.get(`/wallets/${wallet.id}/ledger?limit=1`);

    expect(page.body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(page.body.nextCursor).not.toMatch(/^\d+$/);
  });

  test.each(['cursor=abc', 'cursor=', 'limit=0', 'limit=201', 'limit=dez', 'limit=1.5'])(
    '400 para "%s"',
    async (query) => {
      const wallet = await app.createWallet('1.00');

      const response = await app.get(`/wallets/${wallet.id}/ledger?${query}`);

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_PAYLOAD');
    },
  );

  test('wallet inexistente: 404', async () => {
    expect((await app.get(`/wallets/${Bun.randomUUIDv7()}/ledger`)).status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('wallet íntegra: consistent true, com o contrato do desafio', async () => {
    const wallet = await app.createWallet('1000.00');
    await app.submit(app.payload(wallet, 'BET', '25.00'));
    await app.submit(app.payload(wallet, 'LOSS', '25.00')); // não gera lançamento
    await app.submit(app.payload(wallet, 'BET', '9999.00')); // rejeitada: não gera lançamento

    const response = await app.post(`/wallets/${wallet.id}/reconciliation`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: BRL('975.00'),
      calculatedBalance: BRL('975.00'),
      difference: BRL('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('wallet zerada e sem lançamentos é consistente', async () => {
    const wallet = await app.createWallet('0.00');

    const response = await app.post(`/wallets/${wallet.id}/reconciliation`);

    expect(response.body).toMatchObject({
      storedBalance: BRL('0.00'),
      calculatedBalance: BRL('0.00'),
      consistent: true,
      checkedEntries: 0,
    });
  });

  test('divergência é sinalizada na resposta e na métrica, e NÃO é corrigida', async () => {
    const wallet = await app.createWallet('100.00');
    // Corrompe o saldo por fora da aplicação. Só é possível desligando, como dono
    // da tabela, o trigger que confere saldo x ledger no commit.
    await app.sql.begin(async (tx) => {
      await tx`ALTER TABLE wallets DISABLE TRIGGER wallets_balance_matches_ledger`;
      await tx`UPDATE wallets SET balance = 95.00 WHERE id = ${wallet.id}`;
      await tx`ALTER TABLE wallets ENABLE TRIGGER wallets_balance_matches_ledger`;
    });
    const divergencesBefore = app.metrics.value(MetricName.ReconciliationDivergences);

    const response = await app.post(`/wallets/${wallet.id}/reconciliation`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: BRL('95.00'),
      calculatedBalance: BRL('100.00'),
      difference: BRL('-5.00'),
      consistent: false,
      checkedEntries: 1,
    });
    expect(app.metrics.value(MetricName.ReconciliationDivergences)).toBe(divergencesBefore + 1);
    expect(await app.balanceOf(wallet.id)).toBe('95.00'); // segue divergente: nada foi "consertado"
  });

  test('wallet inexistente: 404', async () => {
    expect((await app.post(`/wallets/${Bun.randomUUIDv7()}/reconciliation`)).status).toBe(404);
  });
});
