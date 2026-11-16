import { describe, expect, test } from 'bun:test';
import { InvalidRequestError } from '../../application/errors';
import { parseWagerMessage, WAGER_CONSUMER_NAME } from './wager-message';

const example = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};

function fields(body: unknown): string[] {
  try {
    parseWagerMessage(typeof body === 'string' ? body : JSON.stringify(body));
  } catch (error) {
    if (error instanceof InvalidRequestError) {
      return error.details.map((detail) => detail.field);
    }
    throw error;
  }
  return [];
}

describe('parseWagerMessage', () => {
  test('a mensagem do desafio vira o mesmo comando que o HTTP monta', () => {
    const command = parseWagerMessage(JSON.stringify(example));

    expect(command).toMatchObject({
      idempotencyKey: 'provider-a:transaction-123',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      referenceExternalTransactionId: undefined,
    });
    expect(command.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test('o messageId do corpo identifica a mensagem na inbox e inicia o rastreio', () => {
    const command = parseWagerMessage(JSON.stringify(example));

    expect(command.inbox).toEqual({ consumerName: WAGER_CONSUMER_NAME, messageId: 'msg-123' });
    expect(command.correlationId).toBe('msg-123');
    expect(command.causationId).toBe('msg-123');
  });

  test.each([
    ['não é JSON', 'isto não é json', ['body']],
    ['JSON que não é objeto', '[1, 2]', ['body']],
    ['messageId ausente', { ...example, messageId: undefined }, ['messageId']],
    ['tipo desconhecido', { ...example, type: 'OutroEvento' }, ['type']],
    ['occurredAt inválido', { ...example, occurredAt: 'ontem' }, ['occurredAt']],
    ['data ausente', { ...example, data: undefined }, ['data']],
    ['sem idempotencyKey', { ...example, data: { ...example.data, idempotencyKey: undefined } }, ['data.idempotencyKey']],
    ['amount como number', { ...example, data: { ...example.data, money: { amount: 25, currency: 'BRL' } } }, ['data.money']],
    ['kind OPENING', { ...example, data: { ...example.data, kind: 'OPENING' } }, ['data.kind']],
    ['walletId que não é UUID', { ...example, data: { ...example.data, walletId: 'w-1' } }, ['data.walletId']],
  ])('%s é recusado', (_caso, body, expected) => {
    expect(fields(body)).toEqual(expect.arrayContaining(expected));
  });

  test('lista os problemas do envelope e do payload de uma vez', () => {
    const problems = fields({ type: 'X', data: { kind: 'Y' } });

    expect(problems).toEqual(
      expect.arrayContaining(['messageId', 'type', 'occurredAt', 'data.idempotencyKey', 'data.providerId', 'data.kind', 'data.money']),
    );
  });
});
