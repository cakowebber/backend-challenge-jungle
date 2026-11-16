import 'reflect-metadata';
import { SQL } from 'bun';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { APP_LOGGER, METRICS } from '../../src/application/ports/observability';
import { loadEnv, type Env } from '../../src/infrastructure/config/env';
import { NestLoggerAdapter, type JsonLogger } from '../../src/infrastructure/observability/json-logger';
import type { PrometheusMetrics } from '../../src/infrastructure/observability/prometheus-metrics';
import { openOrm, recreateTestDatabase } from './test-database';

/**
 * A aplicação Nest REAL (mesmo AppModule do main.ts), ouvindo numa porta
 * livre e apontada para um Postgres real com banco próprio. Os testes falam
 * com ela por HTTP, como um provedor faria.
 */

export interface HttpResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface MoneyJson {
  amount: string;
  currency: string;
}

export interface WalletJson {
  id: string;
  playerId: string;
  balance: MoneyJson;
  version: number;
}

export interface TransactionPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyJson;
  referenceExternalTransactionId?: string;
}

export interface LedgerRow {
  direction: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  transaction_id: string;
}

/**
 * Cliente de uma instância da aplicação: fala com ela por HTTP e confere o
 * resultado direto no banco. Serve tanto para a app embutida no processo do
 * teste (TestApp) quanto para uma instância rodando em outro processo.
 */
export class ApiClient {
  constructor(
    readonly baseUrl: string,
    /** Conexão direta ao banco de teste, para conferir o que foi (ou não) gravado. */
    readonly sql: SQL,
  ) {}

  async request(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...options.headers },
      ...(options.body === undefined
        ? {}
        : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text), headers: response.headers };
  }

  get(path: string): Promise<HttpResult> {
    return this.request('GET', path);
  }

  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
    return this.request('POST', path, { body, ...(headers === undefined ? {} : { headers }) });
  }

  /** Cria uma wallet nova (player aleatório) e devolve o JSON dela. */
  async createWallet(amount = '100.00', currency = 'BRL'): Promise<WalletJson> {
    const result = await this.post('/wallets', {
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount, currency },
    });
    if (result.status !== 201) {
      throw new Error(`falha ao criar wallet de teste: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.body as WalletJson;
  }

  /** Payload válido de transação para a wallet, com id externo único. */
  payload(wallet: WalletJson, kind: string, amount: string, overrides: Partial<TransactionPayload> = {}): TransactionPayload {
    return {
      providerId: 'provider-a',
      externalTransactionId: `ext-${Bun.randomUUIDv7()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: wallet.balance.currency },
      ...overrides,
    };
  }

  /** POST /wagering/transactions. A idempotency key padrão é a recomendada pelo desafio. */
  submit(payload: TransactionPayload, idempotencyKey?: string): Promise<HttpResult> {
    return this.post('/wagering/transactions', payload, {
      'idempotency-key': idempotencyKey ?? `${payload.providerId}:${payload.externalTransactionId}`,
    });
  }

  async balanceOf(walletId: string): Promise<string> {
    const [row] = await this.sql`SELECT balance::text FROM wallets WHERE id = ${walletId}`;
    return row.balance as string;
  }

  /** Lançamentos da wallet em ordem, lidos direto do banco. */
  async ledgerOf(walletId: string): Promise<LedgerRow[]> {
    const rows = await this.sql`
      SELECT direction, amount::text, balance_before::text, balance_after::text, transaction_id
        FROM wallet_ledger_entries WHERE wallet_id = ${walletId} ORDER BY seq`;
    return [...rows]; // array comum, sem os metadados do cliente SQL
  }

  /** Invariante final de todos os testes: saldo gravado == saldo reconstruído pelo ledger. */
  async ledgerMatchesBalance(walletId: string): Promise<boolean> {
    const [row] = await this.sql`
      SELECT w.balance = COALESCE(
               (SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
                  FROM wallet_ledger_entries WHERE wallet_id = w.id), 0) AS matches
        FROM wallets w WHERE w.id = ${walletId}`;
    return row.matches as boolean;
  }

  async eventsOf(aggregateId: string): Promise<string[]> {
    const rows = await this.sql`
      SELECT event_type FROM outbox_messages WHERE aggregate_id = ${aggregateId} ORDER BY event_type`;
    return rows.map((row: { event_type: string }) => row.event_type);
  }

}

export class TestApp extends ApiClient {
  constructor(
    readonly app: INestApplication,
    baseUrl: string,
    sql: SQL,
    readonly env: Env,
  ) {
    super(baseUrl, sql);
  }

  /**
   * Sobe OUTRA instância da aplicação sobre o mesmo banco (pool próprio), como
   * uma segunda réplica faria. Quem chama fecha a instância com close().
   */
  startSibling(overrides: Partial<Env> = {}): Promise<TestApp> {
    return bootApp({ ...this.env, ...overrides });
  }

  get metrics(): PrometheusMetrics {
    return this.app.get<PrometheusMetrics>(METRICS);
  }

  async close(): Promise<void> {
    await this.app.close();
    await this.sql.close();
  }
}

export async function startTestApp(suite: string, overrides: Partial<Env> = {}): Promise<TestApp> {
  const databaseUrl = await recreateTestDatabase(suite);
  const orm = await openOrm(databaseUrl);
  try {
    await orm.migrator.up();
  } finally {
    await orm.close();
  }

  const base = loadEnv();
  return bootApp({
    ...base,
    databaseUrl,
    // TEST_LOGS=1 liga os logs da aplicação para depurar um teste.
    logLevel: process.env.TEST_LOGS === '1' ? base.logLevel : 'silent',
    // Por padrão os testes não consomem fila nem rodam workers em segundo
    // plano; os testes de mensageria ligam o que precisam, com filas próprias.
    consumer: { ...base.consumer, enabled: false },
    outbox: { ...base.outbox, enabled: false },
    pendingReference: { ...base.pendingReference, enabled: false },
    ...overrides,
  });
}

async function bootApp(env: Env): Promise<TestApp> {
  // Como no main.ts: os logs do Nest saem pelo logger da aplicação (silencioso por padrão nos testes).
  const app = await NestFactory.create(AppModule.forRoot(env), { bufferLogs: true });
  app.useLogger(new NestLoggerAdapter(app.get<JsonLogger>(APP_LOGGER)));
  await app.listen(0, '127.0.0.1');

  return new TestApp(app, await app.getUrl(), new SQL(env.databaseUrl), env);
}
