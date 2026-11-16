import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { UnauthenticatedError } from '../../src/application/errors';
import {
  PROVIDER_IDENTITY,
  type ProviderIdentity,
  type ProviderIdentityPort,
} from '../../src/application/ports/provider-identity';
import { startTestApp, type TestApp, type TransactionPayload, type WalletJson } from '../support/test-app';

let app: TestApp;
let wallet: WalletJson;

beforeAll(async () => {
  app = await startTestApp('auth_extension');
  wallet = await app.createWallet('100.00');
});

afterAll(async () => {
  await app.close();
});

function turnAuthenticationOn() {
  const port = app.app.get<ProviderIdentityPort>(PROVIDER_IDENTITY);
  return spyOn(port, 'authenticate').mockImplementation(
    async (authorization: string | undefined): Promise<ProviderIdentity | undefined> => {
      const match = /^Bearer token-de-(.+)$/.exec(authorization ?? '');
      if (match === null) {
        throw new UnauthenticatedError('token ausente ou inválido');
      }
      return { providerId: match[1] as string };
    },
  );
}

function submitAs(payload: TransactionPayload, token: string | undefined) {
  return app.post('/wagering/transactions', payload, {
    'idempotency-key': `${payload.providerId}:${payload.externalTransactionId}`,
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  });
}

async function transactionsOf(externalTransactionId: string): Promise<number> {
  const [row] = await app.sql`
    SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id = ${externalTransactionId}`;
  return row.n as number;
}

describe('autenticação desligada (adaptador no-op, o padrão)', () => {
  test('requisição sem credencial é aceita', async () => {
    const result = await submitAs(app.payload(wallet, 'BET', '1.00'), undefined);

    expect(result.status).toBe(201);
  });
});

describe('com um adaptador de Identity Provider no lugar do no-op', () => {
  let authentication: ReturnType<typeof turnAuthenticationOn>;

  beforeAll(() => {
    authentication = turnAuthenticationOn();
  });

  afterAll(() => {
    authentication.mockRestore();
  });

  afterEach(async () => {
    expect(await app.ledgerMatchesBalance(wallet.id)).toBe(true);
  });

  test('sem credencial: 401 antes de qualquer gravação', async () => {
    const payload = app.payload(wallet, 'BET', '10.00');
    const balanceBefore = await app.balanceOf(wallet.id);

    const result = await submitAs(payload, undefined);

    expect(result.status).toBe(401);
    expect(result.body.code).toBe('UNAUTHENTICATED');
    expect(result.headers.get('www-authenticate')).toBe('Bearer');
    expect(result.headers.get('x-correlation-id')).toBeString();
    expect(await transactionsOf(payload.externalTransactionId)).toBe(0);
    expect(await app.balanceOf(wallet.id)).toBe(balanceBefore);
  });

  test('provedor autenticado agindo em nome de si mesmo: processa normalmente', async () => {
    const payload = app.payload(wallet, 'BET', '10.00', { providerId: 'provider-a' });

    const result = await submitAs(payload, 'token-de-provider-a');

    expect(result.status).toBe(201);
    expect(result.body.status).toBe('PROCESSED');
  });

  test('provedor autenticado submetendo em nome de outro: 403, sem transação e sem débito', async () => {
    const payload = app.payload(wallet, 'BET', '10.00', { providerId: 'provider-a' });
    const balanceBefore = await app.balanceOf(wallet.id);

    const result = await submitAs(payload, 'token-de-provider-b');

    expect(result.status).toBe(403);
    expect(result.body.code).toBe('PROVIDER_NOT_ALLOWED');
    expect(await transactionsOf(payload.externalTransactionId)).toBe(0);
    expect(await app.balanceOf(wallet.id)).toBe(balanceBefore);
  });

  test('consulta por id externo: um provedor não lê as transações de outro', async () => {
    const payload = app.payload(wallet, 'BET', '1.00', { providerId: 'provider-a' });
    await submitAs(payload, 'token-de-provider-a');
    const path = `/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`;

    const own = await app.request('GET', path, { headers: { authorization: 'Bearer token-de-provider-a' } });
    const other = await app.request('GET', path, { headers: { authorization: 'Bearer token-de-provider-b' } });

    expect(own.status).toBe(200);
    expect(other.status).toBe(403);
  });

  test('consulta por id interno: a transação de outro provedor responde 404, como se não existisse', async () => {
    const payload = app.payload(wallet, 'BET', '1.00', { providerId: 'provider-a' });
    const submitted = await submitAs(payload, 'token-de-provider-a');
    const path = `/wagering/transactions/${submitted.body.transactionId}`;

    const own = await app.request('GET', path, { headers: { authorization: 'Bearer token-de-provider-a' } });
    const other = await app.request('GET', path, { headers: { authorization: 'Bearer token-de-provider-b' } });
    const missing = await app.request('GET', `/wagering/transactions/${Bun.randomUUIDv7()}`, {
      headers: { authorization: 'Bearer token-de-provider-b' },
    });

    expect(own.status).toBe(200);
    expect(own.body.transactionId).toBe(submitted.body.transactionId);
    expect(other.status).toBe(404);
    expect(other.body.code).toBe(missing.body.code);
    expect(missing.status).toBe(404);
  });

  test('os endpoints de wallet também exigem credencial', async () => {
    const creation = await app.post('/wallets', {
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    const read = await app.get(`/wallets/${wallet.id}`);

    expect(creation.status).toBe(401);
    expect(read.status).toBe(401);
  });

  test('health checks e /metrics continuam abertos', async () => {
    expect((await app.get('/health/live')).status).toBe(200);
    expect((await app.get('/health/ready')).status).toBe(200);
    expect((await fetch(`${app.baseUrl}/metrics`)).status).toBe(200);
  });
});
