import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { MetricName } from '../../src/application/ports/observability';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { WagerMessageHandler } from '../../src/infrastructure/messaging/wager-message-handler';
import { startTestApp, type TestApp, type WalletJson } from '../support/test-app';
import { eventually, TestQueues, wagerMessageBody } from '../support/test-queues';

/**
 * Consumer contra LocalStack e Postgres REAIS: as mensagens passam pelo SQS de
 * verdade (visibilidade, contagem de recebimentos, redrive) e os efeitos são
 * conferidos no banco.
 */

const MAX_ATTEMPTS = 3;

// Vários testes daqui esperam tempos reais do SQS (backoff de 1s + 2s,
// visibilidade, long poll) e levam de 3 a 5 segundos: o prazo padrão de 5s por
// teste do Bun os derrubava de forma intermitente.
setDefaultTimeout(30_000);

let app: TestApp;
let queues: TestQueues;
let consumer: SqsWagerConsumer;

beforeAll(async () => {
  queues = await TestQueues.create('consumer', MAX_ATTEMPTS);
  app = await startTestApp('sqs_consumer', {
    wagerQueueUrl: queues.queueUrl,
    wagerDlqUrl: queues.dlqUrl,
    databaseLockTimeoutMs: 300,
    consumer: {
      enabled: true,
      concurrency: 3,
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 10,
      maxAttempts: MAX_ATTEMPTS,
      retryBaseDelaySeconds: 1,
      shutdownGraceMs: 5_000,
    },
  });
  consumer = app.app.get(SqsWagerConsumer);
});

beforeEach(() => {
  consumer.start(); // alguns testes param o consumer; cada teste começa com ele rodando
});

afterAll(async () => {
  await app.close();
  await queues.destroy();
});

const BRL = (amount: string) => ({ amount, currency: 'BRL' });

async function transactionByExternalId(externalTransactionId: string) {
  const [row] = await app.sql`
    SELECT id, status, failure_code, kind, observed_balance_amount::text AS balance
      FROM wager_transactions WHERE external_transaction_id = ${externalTransactionId}`;
  return row as { id: string; status: string; failure_code: string | null; kind: string; balance: string } | undefined;
}

async function inboxRows(messageId: string): Promise<number> {
  const [row] = await app.sql`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ${messageId}`;
  return row.n as number;
}

const queueIsEmpty = async () => (await queues.depth(queues.queueUrl)) === 0;

/** Lê e remove as mensagens da DLQ. */
async function deadLetters() {
  const messages = await queues.drain(queues.dlqUrl);
  return messages.map((message) => ({
    body: message.Body as string,
    reason: message.MessageAttributes?.DeadLetterReason?.StringValue,
    detail: message.MessageAttributes?.DeadLetterDetail?.StringValue,
    receiveCount: message.MessageAttributes?.ReceiveCount?.StringValue,
  }));
}

describe('mensagem válida', () => {
  test('é processada pelo mesmo use case do HTTP, registrada na inbox e apagada da fila', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '25.00');

    const messageId = await queues.send(payload);
    await eventually('aposta processada', async () => (await app.balanceOf(wallet.id)) === '75.00');
    await eventually('mensagem apagada (ack)', queueIsEmpty);

    const transaction = await transactionByExternalId(payload.externalTransactionId);
    expect(transaction).toMatchObject({ status: 'PROCESSED', kind: 'BET', balance: '75.00' });
    expect(await inboxRows(messageId)).toBe(1);
    expect(await app.ledgerMatchesBalance(wallet.id)).toBe(true);
    // a transação gravada pela fila é a mesma que o HTTP enxerga
    const viaHttp = await app.get(`/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`);
    expect(viaHttp.body).toMatchObject({ transactionId: transaction?.id, status: 'PROCESSED', balance: BRL('75.00') });
  });

  test('inbox, transação, lançamento e eventos são gravados na MESMA transação SQL', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '10.00');

    const messageId = await queues.send(payload);
    await eventually('aposta processada', async () => (await app.balanceOf(wallet.id)) === '90.00');

    // xmin é o id da transação do Postgres que gravou a linha.
    const [row] = await app.sql`
      SELECT (SELECT xmin::text FROM inbox_messages WHERE message_id = ${messageId}) AS inbox,
             (SELECT e.xmin::text FROM wallet_ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id
               WHERE t.external_transaction_id = ${payload.externalTransactionId}) AS ledger,
             (SELECT min(xmin::text) FROM outbox_messages WHERE payload->>'causationId' = ${messageId}) AS outbox`;
    expect(row.inbox).toBe(row.ledger);
    expect(row.inbox).toBe(row.outbox);
  });

  test('o messageId acompanha os eventos como correlationId e causationId', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '10.00');

    const messageId = await queues.send(payload);
    await eventually('eventos gravados', async () => {
      const [row] = await app.sql`
        SELECT count(*)::int AS n FROM outbox_messages WHERE payload->>'causationId' = ${messageId}`;
      return row.n === 2;
    });

    const events = await app.sql`
      SELECT event_type, payload->>'correlationId' AS correlation FROM outbox_messages
       WHERE payload->>'causationId' = ${messageId} ORDER BY event_type`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(events.every((e: { correlation: string }) => e.correlation === messageId)).toBe(true);
  });

  test('rejeição de negócio fica gravada como REJECTED e a mensagem recebe ack', async () => {
    const wallet = await app.createWallet('10.00');
    const payload = app.payload(wallet, 'BET', '50.00');

    await queues.send(payload);
    await eventually('rejeição gravada', async () => (await transactionByExternalId(payload.externalTransactionId)) !== undefined);
    await eventually('mensagem apagada (ack)', queueIsEmpty);

    expect(await transactionByExternalId(payload.externalTransactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
    expect(await app.balanceOf(wallet.id)).toBe('10.00');
    expect(await deadLetters()).toEqual([]);
  });

  test('mensagens do mesmo grupo são processadas em ordem: BET e depois o REFUND dela', async () => {
    const wallet = await app.createWallet('100.00');
    const bet = app.payload(wallet, 'BET', '40.00');
    const refund = app.payload(wallet, 'REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId });

    await queues.send(bet); // mesmo grupo (a wallet)
    await queues.send(refund);
    await eventually('as duas resolvidas', async () => {
      const row = await transactionByExternalId(refund.externalTransactionId);
      return row !== undefined;
    });

    // Se o REFUND passasse na frente, ficaria PENDING_REFERENCE.
    expect(await transactionByExternalId(refund.externalTransactionId)).toMatchObject({ status: 'PROCESSED' });
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
  });
});

describe('redelivery não duplica efeito', () => {
  test('worker morre depois do commit e antes do ack: o SQS reentrega e a inbox descarta', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '25.00');
    const handler = app.app.get(WagerMessageHandler);

    // Um "worker" recebe a mensagem, commita o efeito e morre sem apagar a mensagem.
    await consumer.stop();
    const messageId = await queues.send(payload);
    const [received] = await queues.receive(queues.queueUrl, { waitSeconds: 2, visibilitySeconds: 1 });
    const disposition = await handler.handle({ body: received?.Body as string, receiveCount: 1 });
    expect(disposition).toEqual({ action: 'ACK', outcome: 'PROCESSED' });
    expect(await app.balanceOf(wallet.id)).toBe('75.00');
    // ...e aqui ele morreria: o DeleteMessage nunca é enviado.

    // A visibilidade expira e outra instância assume.
    const duplicatesBefore = app.metrics.value(MetricName.MessagesByOutcome, { outcome: 'DUPLICATE' });
    consumer.start();
    await eventually('redelivery descartada e apagada', queueIsEmpty);

    expect(app.metrics.value(MetricName.MessagesByOutcome, { outcome: 'DUPLICATE' })).toBe(duplicatesBefore + 1);
    expect(await app.balanceOf(wallet.id)).toBe('75.00'); // um débito só
    expect((await app.ledgerOf(wallet.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    expect(await inboxRows(messageId)).toBe(1);
    expect(await app.eventsOf(wallet.id)).toEqual(['WalletBalanceChanged', 'WalletBalanceChanged']); // abertura + 1 aposta
  });

  test('o produtor reenvia a mesma mensagem (mesmo messageId) 5 vezes: um efeito', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '10.00');
    const messageId = `msg-${Bun.randomUUIDv7()}`;

    for (let i = 0; i < 5; i++) {
      await queues.send(payload, { messageId });
    }
    await eventually('todas as cópias apagadas', queueIsEmpty);

    expect(await app.balanceOf(wallet.id)).toBe('90.00');
    expect(await inboxRows(messageId)).toBe(1);
    expect(await deadLetters()).toEqual([]);
  });

  test('mensagens DIFERENTES com a mesma operação (mesma idempotency key): um efeito', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '10.00');

    const first = await queues.send(payload);
    const second = await queues.send(payload);
    await eventually('as duas apagadas', queueIsEmpty);

    expect(await app.balanceOf(wallet.id)).toBe('90.00');
    // as duas mensagens ficam registradas; só a primeira gerou efeito
    expect((await inboxRows(first)) + (await inboxRows(second))).toBe(2);
  });

  test('a mesma operação por HTTP e pela fila: um efeito', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '10.00');

    const viaHttp = await app.submit(payload);
    await queues.send(payload);
    await eventually('mensagem apagada', queueIsEmpty);
    const replay = await app.submit(payload);

    expect(viaHttp.status).toBe(201);
    expect(replay.body).toEqual({ ...viaHttp.body, idempotentReplay: true });
    expect(await app.balanceOf(wallet.id)).toBe('90.00');
  });

  test('30 mensagens distintas para a mesma wallet, 3 workers: nenhuma se perde nem duplica', async () => {
    const wallet = await app.createWallet('100.00');

    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        // grupos diferentes, para os workers realmente disputarem a wallet
        queues.send(app.payload(wallet, 'BET', '10.00'), { group: `grupo-${i}` }),
      ),
    );
    await eventually('fila vazia', queueIsEmpty, 30_000);

    const [counts] = await app.sql`
      SELECT count(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
             count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
        FROM wager_transactions WHERE wallet_id = ${wallet.id} AND kind = 'BET'`;
    expect(counts).toMatchObject({ processed: 10, rejected: 20 });
    expect(await app.balanceOf(wallet.id)).toBe('0.00');
    expect(await app.ledgerMatchesBalance(wallet.id)).toBe(true);
    expect(await deadLetters()).toEqual([]);
  });
});

describe('mensagem venenosa vai para a DLQ', () => {
  test('corpo que não é JSON: DLQ na primeira tentativa, com o motivo', async () => {
    await queues.sendRaw('isto não é json {', 'veneno-1');

    await eventually('fila principal vazia', queueIsEmpty);
    const [dead] = await deadLetters();

    expect(dead).toMatchObject({ body: 'isto não é json {', reason: 'INVALID_MESSAGE', receiveCount: '1' });
    expect(dead?.detail).toContain('não é um JSON válido');
  });

  test('envelope ou payload inválido: DLQ com todos os problemas listados, e nada gravado', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '25.00');
    const body = JSON.stringify({
      messageId: 'msg-venenosa',
      type: 'TipoDesconhecido',
      occurredAt: 'ontem',
      data: { ...payload, money: { amount: 25, currency: 'BRL' }, kind: 'OPENING' }, // sem idempotencyKey
    });

    await queues.sendRaw(body, wallet.id);
    await eventually('fila principal vazia', queueIsEmpty);
    const [dead] = await deadLetters();

    expect(dead?.reason).toBe('INVALID_MESSAGE');
    for (const field of ['type', 'occurredAt', 'data.idempotencyKey', 'data.money', 'data.kind']) {
      expect(dead?.detail).toContain(field);
    }
    expect(await transactionByExternalId(payload.externalTransactionId)).toBeUndefined();
    expect(await inboxRows('msg-venenosa')).toBe(0);
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
  });

  test('payload que só o domínio recusa (REFUND sem referência): DLQ', async () => {
    const wallet = await app.createWallet('100.00');

    await queues.send(app.payload(wallet, 'REFUND', '10.00'));
    await eventually('fila principal vazia', queueIsEmpty);

    expect((await deadLetters())[0]?.reason).toBe('INVALID_PAYLOAD');
  });

  test('wallet inexistente: nada é gravado, então a mensagem é preservada na DLQ em vez de receber ack', async () => {
    const ghost: WalletJson = { id: Bun.randomUUIDv7(), playerId: 'p', balance: BRL('0.00'), version: 1 };
    const payload = app.payload(ghost, 'BET', '10.00');

    const messageId = await queues.send(payload);
    await eventually('fila principal vazia', queueIsEmpty);
    const [dead] = await deadLetters();

    expect(dead?.reason).toBe('WALLET_NOT_FOUND');
    expect(JSON.parse(dead?.body as string).messageId).toBe(messageId);
    expect(await inboxRows(messageId)).toBe(0); // o registro da inbox foi desfeito junto com a transação
  });

  test('mesma idempotency key com payload divergente: DLQ, sem alterar o saldo', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '10.00');
    await app.submit(payload);

    await queues.send({ ...payload, money: BRL('99.00') });
    await eventually('fila principal vazia', queueIsEmpty);

    expect((await deadLetters())[0]?.reason).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(await app.balanceOf(wallet.id)).toBe('90.00');
  });

  test('mesmo messageId reaproveitado com outro conteúdo: DLQ', async () => {
    const wallet = await app.createWallet('100.00');
    const messageId = `msg-${Bun.randomUUIDv7()}`;
    await queues.send(app.payload(wallet, 'BET', '10.00'), { messageId });
    await eventually('primeira processada', async () => (await app.balanceOf(wallet.id)) === '90.00');

    await queues.send(app.payload(wallet, 'BET', '10.00'), { messageId }); // outra operação, mesmo messageId
    await eventually('fila principal vazia', queueIsEmpty);

    expect((await deadLetters())[0]?.reason).toBe('MESSAGE_ID_CONFLICT');
    expect(await app.balanceOf(wallet.id)).toBe('90.00');
  });

  test('erro inesperado em toda tentativa: esgota o limite, grava FAILED e vai para a DLQ', async () => {
    // Falha real do banco na gravação do evento de sucesso, só para mensagens marcadas.
    await app.sql.unsafe(`
      CREATE FUNCTION test_poison_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'WagerTransactionProcessed' AND NEW.payload->>'causationId' LIKE 'msg-quebra-%' THEN
          RAISE EXCEPTION 'falha injetada pelo teste';
        END IF;
        RETURN NEW;
      END $$`);
    await app.sql.unsafe(`
      CREATE TRIGGER test_poison_outbox BEFORE INSERT ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION test_poison_outbox()`);

    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '25.00');
    const messageId = `msg-quebra-${Bun.randomUUIDv7()}`;
    const retriesBefore = app.metrics.value(MetricName.MessageRetries, { reason: 'UNEXPECTED_ERROR' });

    await queues.send(payload, { messageId });
    await eventually('fila principal vazia', queueIsEmpty, 30_000);
    const [dead] = await deadLetters();

    expect(dead).toMatchObject({ reason: 'PROCESSING_FAILED', receiveCount: String(MAX_ATTEMPTS) });
    expect(dead?.detail).toContain('registro FAILED: RECORDED');
    // tentou MAX_ATTEMPTS vezes: MAX_ATTEMPTS - 1 retries com backoff e a tentativa final
    expect(app.metrics.value(MetricName.MessageRetries, { reason: 'UNEXPECTED_ERROR' })).toBe(retriesBefore + MAX_ATTEMPTS - 1);

    // A operação fica auditável como FAILED, sem efeito financeiro.
    const failed = await transactionByExternalId(payload.externalTransactionId);
    expect(failed).toMatchObject({ status: 'FAILED', failure_code: 'PROCESSING_FAILED' });
    expect(await app.eventsOf(failed?.id as string)).toEqual(['WagerTransactionFailed']);
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
    expect(await app.ledgerOf(wallet.id)).toHaveLength(1);
    expect(await inboxRows(messageId)).toBe(1);

    // FAILED é terminal: reenviar a mesma mensagem não processa, só reconhece.
    await queues.send(payload, { messageId });
    await eventually('reenvio apagado', queueIsEmpty);
    expect(await app.balanceOf(wallet.id)).toBe('100.00');
    const replay = await app.submit(payload);
    expect(replay.status).toBe(500);
    expect(replay.body).toMatchObject({ status: 'FAILED', failureCode: 'PROCESSING_FAILED', idempotentReplay: true });
  });
});

describe('falha transitória', () => {
  test('wallet travada: a mensagem não é apagada, volta com backoff e processa depois', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '25.00');
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = app.sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      locked();
      await released;
    });
    await lockTaken;
    const retriesBefore = app.metrics.value(MetricName.MessageRetries, { reason: 'LOCK_TIMEOUT' });

    const messageId = await queues.send(payload);
    await eventually(
      'primeira tentativa falhou por lock',
      async () => app.metrics.value(MetricName.MessageRetries, { reason: 'LOCK_TIMEOUT' }) > retriesBefore,
    );

    // Falhou, mas nada foi gravado e a mensagem continua na fila (invisível, em backoff).
    expect(await transactionByExternalId(payload.externalTransactionId)).toBeUndefined();
    expect(await inboxRows(messageId)).toBe(0);
    expect(await queues.depth(queues.queueUrl)).toBe(1);

    release();
    await holder;
    await eventually('processada na reentrega', async () => (await app.balanceOf(wallet.id)) === '75.00');
    await eventually('mensagem apagada', queueIsEmpty);

    expect(await transactionByExternalId(payload.externalTransactionId)).toMatchObject({ status: 'PROCESSED' });
    expect(await deadLetters()).toEqual([]);
    expect(consumer.isPaused).toBe(false); // lock de uma wallet não pausa o consumo
  });
});

describe('SIGTERM / shutdown', () => {
  test('para de buscar, e a mensagem em andamento que não termina a tempo é devolvida à fila', async () => {
    // Instância própria: espera longa pelo lock e prazo curto de shutdown.
    const ownQueues = await TestQueues.create('consumer-shutdown', MAX_ATTEMPTS);
    const instance = await startTestApp('sqs_consumer_shutdown', {
      wagerQueueUrl: ownQueues.queueUrl,
      wagerDlqUrl: ownQueues.dlqUrl,
      databaseLockTimeoutMs: 10_000,
      consumer: {
        enabled: true,
        concurrency: 2,
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: 30,
        maxAttempts: MAX_ATTEMPTS,
        retryBaseDelaySeconds: 1,
        shutdownGraceMs: 500,
      },
    });
    const worker = instance.app.get(SqsWagerConsumer);
    let release: () => void = () => undefined;
    let holder: Promise<unknown> = Promise.resolve();

    try {
      const wallet = await instance.createWallet('100.00');
      const payload = instance.payload(wallet, 'BET', '25.00');
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      holder = instance.sql.begin(async (tx) => {
        await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
        locked();
        await released;
      });
      await lockTaken;

      // A mensagem fica em andamento, presa esperando o lock da wallet.
      await ownQueues.send(payload);
      await eventually('mensagem em andamento', async () => worker.inFlightCount === 1);

      const started = performance.now();
      await worker.stop(); // o que o SIGTERM dispara (beforeApplicationShutdown)
      const elapsed = performance.now() - started;

      expect(elapsed).toBeGreaterThanOrEqual(450); // esperou o prazo...
      expect(elapsed).toBeLessThan(3_000); // ...e não a visibilidade de 30s
      expect(worker.isRunning).toBe(false);

      // Devolvida: já está visível de novo, sem esperar os 30s.
      const [returned] = await ownQueues.receive(ownQueues.queueUrl, { waitSeconds: 2, visibilitySeconds: 0 });
      expect(JSON.parse(returned?.Body as string).data.externalTransactionId).toBe(payload.externalTransactionId);
      expect(returned?.Attributes?.ApproximateReceiveCount).toBe('2');

      // Parou de buscar: mensagem nova fica na fila.
      const other = instance.payload(wallet, 'BET', '1.00');
      await ownQueues.send(other, { group: 'outro-grupo' });
      await Bun.sleep(1_500);
      const [row] = await instance.sql`
        SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id = ${other.externalTransactionId}`;
      expect(row.n).toBe(0);

      // O lock é solto: a transação que estava em andamento ainda commita...
      release();
      await holder;
      await eventually('efeito da mensagem em andamento', async () => (await instance.balanceOf(wallet.id)) === '75.00');

      // ...e a cópia devolvida, ao ser reentregue para outra instância, é descartada pela inbox.
      worker.start();
      await eventually('fila vazia', async () => (await ownQueues.depth(ownQueues.queueUrl)) === 0, 20_000);
      expect(await instance.balanceOf(wallet.id)).toBe('74.00'); // 25.00 uma vez + 1.00 da outra mensagem
      expect((await instance.ledgerOf(wallet.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(2);
      expect(await instance.ledgerMatchesBalance(wallet.id)).toBe(true);
    } finally {
      release(); // se uma asserção falhar antes, o lock não pode ficar preso
      await holder.catch(() => undefined);
      await instance.close();
      await ownQueues.destroy();
    }
  }, 60_000);

  test('mensagem em andamento que termina dentro do prazo é concluída com ack antes de parar', async () => {
    const wallet = await app.createWallet('100.00');
    const payload = app.payload(wallet, 'BET', '25.00');

    await queues.send(payload);
    await eventually('processada', async () => (await app.balanceOf(wallet.id)) === '75.00');
    await consumer.stop();

    expect(consumer.inFlightCount).toBe(0);
    expect(await queueIsEmpty()).toBe(true);
  });
});

describe('WagerMessageHandler — classificação sem passar pela fila', () => {
  test('o backoff de retry dobra com a contagem de recebimentos, a partir da base configurada', async () => {
    const wallet = await app.createWallet('100.00');
    const handler = app.app.get(WagerMessageHandler);
    const body = wagerMessageBody(app.payload(wallet, 'BET', '25.00'), { messageId: `msg-${Bun.randomUUIDv7()}` });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = app.sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      locked();
      await released;
    });
    await lockTaken;

    const first = await handler.handle({ body, receiveCount: 1 });
    const third = await handler.handle({ body, receiveCount: 3 });
    release();
    await holder;

    expect(first).toEqual({ action: 'RETRY', reason: 'LOCK_TIMEOUT', delaySeconds: 1, pauseConsumption: false });
    expect(third).toMatchObject({ action: 'RETRY', delaySeconds: 4 });
  });
});
