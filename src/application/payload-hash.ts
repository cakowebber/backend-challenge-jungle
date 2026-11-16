import { createHash } from 'node:crypto';
import type { MoneyProps } from '../domain/money';

/**
 * payloadHash da idempotência.
 *
 * Algoritmo:
 *   1. monta um objeto só com os campos de NEGÓCIO (lista em WagerBusinessPayload);
 *      header Idempotency-Key, messageId, occurredAt, correlationId etc. ficam fora;
 *   2. serializa em JSON canônico: chaves em ordem alfabética em todos os níveis,
 *      sem espaços, campos ausentes omitidos, strings escapadas como JSON.stringify;
 *   3. SHA-256 dos bytes UTF-8, em hexadecimal minúsculo (64 caracteres).
 *
 * O mesmo payload de negócio produz o mesmo hash venha por HTTP ou pela fila,
 * em qualquer ordem de chaves. Valores não são normalizados: o Money já chega
 * em grafia única ("25.00"), então não há duas formas de escrever o mesmo valor.
 */
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
  // Números não têm forma canônica única (1, 1.0, 1e0) e os contratos não usam
  // nenhum: dinheiro é string. Recusar aqui evita introduzir um por engano.
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
