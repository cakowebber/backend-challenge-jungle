import { describe, expect, test } from 'bun:test';
import { canonicalJson, sha256Hex, wagerPayloadHash, type WagerBusinessPayload } from './payload-hash';

const payload: WagerBusinessPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('ordena as chaves em todos os níveis e não usa espaços', () => {
    expect(canonicalJson({ b: '2', a: { d: '4', c: '3' } })).toBe('{"a":{"c":"3","d":"4"},"b":"2"}');
  });

  test('a ordem em que as chaves foram escritas não muda o resultado', () => {
    expect(canonicalJson({ a: '1', b: '2' })).toBe(canonicalJson({ b: '2', a: '1' }));
  });

  test('campos undefined são omitidos; null é mantido', () => {
    expect(canonicalJson({ a: '1', b: undefined, c: null })).toBe('{"a":"1","c":null}');
  });

  test('arrays mantêm a ordem dos elementos', () => {
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });

  test('strings são escapadas como JSON', () => {
    expect(canonicalJson({ a: 'aspas " e \n quebra' })).toBe('{"a":"aspas \\" e \\n quebra"}');
  });

  test('números são recusados: não têm forma canônica única e dinheiro é string', () => {
    expect(() => canonicalJson({ amount: 25 as unknown as string })).toThrow(TypeError);
  });
});

describe('wagerPayloadHash', () => {
  test('é o SHA-256 em hexadecimal do JSON canônico dos campos de negócio', () => {
    const canonical =
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
      '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
      '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';

    expect(wagerPayloadHash(payload)).toBe(sha256Hex(canonical));
    expect(wagerPayloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('sha256Hex confere com um vetor conhecido', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('o mesmo payload em outra ordem de chaves tem o mesmo hash', () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as unknown as WagerBusinessPayload;

    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(payload));
  });

  test.each([
    ['valor', { money: { amount: '25.01', currency: 'BRL' } }],
    ['moeda', { money: { amount: '25.00', currency: 'USD' } }],
    ['kind', { kind: 'WIN' }],
    ['wallet', { walletId: '0192f291-27dd-7d3f-8071-000000000000' }],
    ['player', { playerId: 'outro' }],
    ['rodada', { roundId: 'round-988' }],
    ['jogo', { gameId: 'outro-jogo' }],
    ['id externo', { externalTransactionId: 'transaction-124' }],
    ['provider', { providerId: 'provider-b' }],
    ['referência', { referenceExternalTransactionId: 'bet-1' }],
  ])('qualquer campo de negócio diferente (%s) muda o hash', (_campo, change) => {
    expect(wagerPayloadHash({ ...payload, ...change })).not.toBe(wagerPayloadHash(payload));
  });

  test('metadados de transporte não entram: campos extras são ignorados', () => {
    const withTransport = {
      ...payload,
      idempotencyKey: 'provider-a:transaction-123',
      messageId: 'msg-123',
      occurredAt: '2026-07-29T15:00:00.000Z',
      correlationId: 'corr-1',
    } as WagerBusinessPayload;

    expect(wagerPayloadHash(withTransport)).toBe(wagerPayloadHash(payload));
  });

  test('referência ausente e referência undefined são o mesmo payload', () => {
    expect(wagerPayloadHash({ ...payload, referenceExternalTransactionId: undefined })).toBe(wagerPayloadHash(payload));
  });
});
