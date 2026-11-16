import { describe, expect, test } from 'bun:test';
import { brl, NOW, persisted, submitted, walletWith } from '../../test/support/domain-fixtures';
import { backoffDelayMs, type BackoffPolicy } from './backoff';
import { DomainInvariantError, DomainValidationError } from './errors';
import type { EventContext } from './events/integration-event';
import {
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from './events/wager-events';
import { BusinessFailureCode, InfrastructureFailureCode } from './failure-code';
import { InboxMessage } from './inbox-message';
import { OutboxMessage } from './outbox-message';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from './wager-transaction';
import { LedgerDirection } from './wallet-ledger-entry';

const POLICY: BackoffPolicy = { baseDelayMs: 1_000, maxDelayMs: 30_000 };
const LATER = new Date(NOW.getTime() + 5_000);

const ctx: EventContext = {
  eventId: 'event-1',
  correlationId: 'corr-1',
  causationId: 'msg-123',
  occurredAt: NOW,
};

describe('backoffDelayMs', () => {
  test('dobra a cada tentativa até o teto', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffDelayMs(attempt, POLICY));

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  test('não estoura com número alto de tentativas', () => {
    expect(backoffDelayMs(10_000, POLICY)).toBe(30_000);
  });

  test.each([0, -1, 1.5, Number.NaN])('tentativa inválida: %p', (attempt) => {
    expect(() => backoffDelayMs(attempt, POLICY)).toThrow(DomainInvariantError);
  });
});

describe('InboxMessage', () => {
  const props = { messageId: 'msg-123', consumerName: 'wager-consumer', payloadHash: 'hash', receivedAt: NOW };

  test('é recebida como não processada', () => {
    const message = InboxMessage.receive(props);

    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test('markProcessed registra quando', () => {
    const message = InboxMessage.receive(props);

    message.markProcessed(LATER);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toBe(LATER);
  });

  test('marcar duas vezes é erro de programação', () => {
    const message = InboxMessage.receive(props);
    message.markProcessed(LATER);

    expect(() => message.markProcessed(LATER)).toThrow(DomainInvariantError);
  });

  test('exige messageId, consumerName e payloadHash', () => {
    expect(() => InboxMessage.receive({ ...props, messageId: '' })).toThrow(DomainValidationError);
    expect(() => InboxMessage.receive({ ...props, consumerName: '' })).toThrow(DomainValidationError);
    expect(() => InboxMessage.receive({ ...props, payloadHash: '' })).toThrow(DomainValidationError);
  });

  test('rehydrate reconstrói o estado persistido', () => {
    const message = InboxMessage.rehydrate({ ...props, processedAt: LATER });

    expect(message.isProcessed()).toBe(true);
  });
});

describe('eventos de integração', () => {
  test('WalletBalanceChanged leva o tipo e a versão na classe e dinheiro como string', () => {
    const wallet = walletWith(brl('100.00'));
    const entry = wallet.debit({ entryId: 'entry-1', transactionId: 'tx-1', money: brl('80.00'), at: NOW });

    const event = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(wallet.id);
    expect(event.toJSON()).toEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'msg-123',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '80.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '20.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('o envelope é JSON estável: serializar e desserializar preserva tudo', () => {
    const wallet = walletWith(brl('100.00'));
    const entry = wallet.credit({ entryId: 'entry-1', transactionId: 'tx-1', money: brl('0.10'), at: NOW });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  test('causationId ausente não aparece no envelope', () => {
    const tx = persisted();

    const envelope = WagerTransactionProcessed.from(tx, { ...ctx, causationId: undefined }).toJSON();

    expect('causationId' in envelope).toBe(false);
  });

  test('data é congelado', () => {
    const event = WagerTransactionProcessed.from(persisted(), ctx);

    expect(Object.isFrozen(event.data)).toBe(true);
  });

  test('WalletBalanceChanged recusa lançamento de outra wallet', () => {
    const wallet = walletWith(brl('100.00'));
    const outra = walletWith(brl('100.00'), { id: 'wallet-2' });
    const entry = outra.credit({ entryId: 'entry-1', transactionId: 'tx-1', money: brl('1.00'), at: NOW });

    expect(() => WalletBalanceChanged.from(wallet, entry, ctx)).toThrow(DomainInvariantError);
  });

  test('WagerTransactionProcessed vale inclusive para LOSS', () => {
    const loss = persisted({ kind: Kind.Loss, money: brl('25.00') });

    const event = WagerTransactionProcessed.from(loss, ctx);

    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.aggregateId).toBe(loss.id);
    expect(event.data).toMatchObject({
      transactionId: loss.id,
      kind: Kind.Loss,
      money: { amount: '25.00', currency: 'BRL' },
      referenceTransactionId: null,
      processedAt: '2026-07-29T15:00:00.000Z',
    });
  });

  test('WagerTransactionRejected carrega o failureCode', () => {
    const rejected = persisted({
      status: Status.Rejected,
      failureCode: BusinessFailureCode.InsufficientFunds,
      processedAt: undefined,
    });

    const event = WagerTransactionRejected.from(rejected, ctx);

    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.data.failureCode).toBe(BusinessFailureCode.InsufficientFunds);
  });

  test('WagerTransactionPendingReference informa a referência aguardada e a próxima tentativa', () => {
    const pending = persisted({
      kind: Kind.Rollback,
      referenceExternalTransactionId: 'bet-1',
      status: Status.PendingReference,
      processedAt: undefined,
      nextReferenceAttemptAt: LATER,
    });

    const event = WagerTransactionPendingReference.from(pending, ctx);

    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.data.referenceExternalTransactionId).toBe('bet-1');
    expect(event.data.nextAttemptAt).toBe(LATER.toISOString());
  });

  test('WagerTransactionFailed carrega o código de infraestrutura', () => {
    const failed = persisted({
      status: Status.Failed,
      failureCode: InfrastructureFailureCode.ProcessingFailed,
      processedAt: undefined,
    });

    const event = WagerTransactionFailed.from(failed, ctx);

    expect(event.eventType).toBe('WagerTransactionFailed');
    expect(event.aggregateId).toBe(failed.id);
    expect(event.data.failureCode).toBe(InfrastructureFailureCode.ProcessingFailed);
  });

  test('cada evento só nasce de uma transação no estado correspondente', () => {
    const pendente = submitted(Kind.Bet, brl('25.00'));

    expect(() => WagerTransactionProcessed.from(pendente, ctx)).toThrow(DomainInvariantError);
    expect(() => WagerTransactionRejected.from(pendente, ctx)).toThrow(DomainInvariantError);
    expect(() => WagerTransactionPendingReference.from(pendente, ctx)).toThrow(DomainInvariantError);
    expect(() => WagerTransactionFailed.from(pendente, ctx)).toThrow(DomainInvariantError);
  });
});

describe('OutboxMessage', () => {
  function enqueued(): OutboxMessage {
    return OutboxMessage.enqueue(WagerTransactionProcessed.from(persisted({ id: 'tx-1' }), ctx));
  }

  test('enqueue guarda o envelope serializado e usa o eventId como id', () => {
    const message = enqueued();

    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe('tx-1');
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.occurredAt).toBe(NOW);
    expect(message.payload).toMatchObject({ eventId: 'event-1', eventType: 'WagerTransactionProcessed', version: 1 });
    expect(Object.isFrozen(message.payload)).toBe(true);
  });

  test('nasce pendente e já devida, sem tentativas', () => {
    const message = enqueued();

    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
    expect(message.attempts).toBe(0);
    expect(message.publishedAt).toBeUndefined();
  });

  test('scheduleRetry incrementa attempts e adia com backoff', () => {
    const message = enqueued();

    message.scheduleRetry(NOW, POLICY);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(new Date(NOW.getTime() + 1_000));
    expect(message.isDue(NOW)).toBe(false);
    expect(message.isDue(new Date(NOW.getTime() + 1_000))).toBe(true);

    message.scheduleRetry(NOW, POLICY);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(new Date(NOW.getTime() + 2_000));
  });

  test('markPublished encerra: não está mais pendente nem devida', () => {
    const message = enqueued();
    message.scheduleRetry(NOW, POLICY);

    message.markPublished(LATER);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(message.publishedAt).toBe(LATER);
    expect(message.nextAttemptAt).toBeUndefined();
  });

  test('mensagem publicada não aceita nova publicação nem retry', () => {
    const message = enqueued();
    message.markPublished(LATER);

    expect(() => message.markPublished(LATER)).toThrow(DomainInvariantError);
    expect(() => message.scheduleRetry(LATER, POLICY)).toThrow(DomainInvariantError);
  });

  test('rehydrate reconstrói o estado persistido', () => {
    const message = OutboxMessage.rehydrate({
      id: 'event-9',
      aggregateId: 'tx-9',
      eventType: 'WagerTransactionRejected',
      payload: { eventId: 'event-9' },
      occurredAt: NOW,
      attempts: 4,
      nextAttemptAt: LATER,
      publishedAt: undefined,
    });

    expect(message.attempts).toBe(4);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(false);
  });
});
