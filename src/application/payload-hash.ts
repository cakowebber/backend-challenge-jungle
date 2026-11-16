import { createHash } from 'node:crypto';
import type { MoneyProps } from '../domain/money';

export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export type CanonicalValue = string | boolean | null | CanonicalValue[] | { [key: string]: CanonicalValue | undefined };

export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as CanonicalValue)}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`Valor não canonizável no payload: ${typeof value}`);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function wagerPayloadHash(payload: WagerBusinessPayload): string {
  return sha256Hex(
    canonicalJson({
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: { amount: payload.money.amount, currency: payload.money.currency },
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
    }),
  );
}
