import { DomainError } from '../domain/errors';
import { Money } from '../domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction';
import { InvalidRequestError, type FieldError } from './errors';
import type { InboxReference, ProcessWagerTransactionCommand } from './process-wager-transaction';

const MAX_TEXT_LENGTH = 255;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUBMITTABLE_KINDS: readonly string[] = Object.values(WagerTransactionKind).filter(
  (kind) => kind !== WagerTransactionKind.Opening,
);

export class Problems {
  private readonly list: FieldError[] = [];

  add(field: string, message: string): undefined {
    this.list.push({ field, message });
    return undefined;
  }

  throwIfAny(): void {
    if (this.list.length > 0) {
      throw new InvalidRequestError(this.list);
    }
  }
}

export function asObject(value: unknown, field: string, problems: Problems): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.add(field, 'deve ser um objeto JSON');
    return {};
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, field: string, problems: Problems): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return problems.add(field, 'é obrigatório e deve ser uma string não vazia');
  }
  if (value.length > MAX_TEXT_LENGTH) {
    return problems.add(field, `deve ter no máximo ${MAX_TEXT_LENGTH} caracteres`);
  }
  return value;
}

export function optionalText(value: unknown, field: string, problems: Problems): string | undefined {
  return value === undefined || value === null ? undefined : text(value, field, problems);
}

export function uuid(value: unknown, field: string, problems: Problems): string | undefined {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    return problems.add(field, 'deve ser um UUID');
  }
  return value.toLowerCase();
}

export function money(value: unknown, field: string, problems: Problems): Money | undefined {
  const props = asObject(value, field, problems);
  try {
    return Money.from({ amount: props.amount as string, currency: props.currency as string });
  } catch (error) {
    if (error instanceof DomainError) {
      return problems.add(field, error.message);
    }
    throw error;
  }
}

export interface WagerTransactionInputMetadata {
  idempotencyKey: unknown;
  idempotencyKeyField: string;
  correlationId: string;
  causationId: string | undefined;
  inbox: InboxReference | undefined;
}

export function parseWagerTransactionInput(
  input: unknown,
  metadata: WagerTransactionInputMetadata,
  problems = new Problems(),
  path = '',
): ProcessWagerTransactionCommand {
  const body = asObject(input, path === '' ? 'body' : path.slice(0, -1), problems);
  const field = (name: string) => `${path}${name}`;

  let idempotencyKey: string | undefined;
  if (typeof metadata.idempotencyKey !== 'string' || metadata.idempotencyKey.trim() === '') {
    problems.add(metadata.idempotencyKeyField, 'é obrigatório');
  } else if (metadata.idempotencyKey.length > MAX_TEXT_LENGTH) {
    problems.add(metadata.idempotencyKeyField, `deve ter no máximo ${MAX_TEXT_LENGTH} caracteres`);
  } else {
    idempotencyKey = metadata.idempotencyKey.trim();
  }

  const providerId = text(body.providerId, field('providerId'), problems);
  const externalTransactionId = text(body.externalTransactionId, field('externalTransactionId'), problems);
  const playerId = text(body.playerId, field('playerId'), problems);
  const walletId = uuid(body.walletId, field('walletId'), problems);
  const roundId = text(body.roundId, field('roundId'), problems);
  const gameId = text(body.gameId, field('gameId'), problems);
  const amount = money(body.money, field('money'), problems);
  const referenceExternalTransactionId = optionalText(
    body.referenceExternalTransactionId,
    field('referenceExternalTransactionId'),
    problems,
  );

  const kind = body.kind;
  if (typeof kind !== 'string' || !SUBMITTABLE_KINDS.includes(kind)) {
    problems.add(field('kind'), `deve ser um de: ${SUBMITTABLE_KINDS.join(', ')}`);
  }

  problems.throwIfAny();
  return {
    idempotencyKey: idempotencyKey as string,
    providerId: providerId as string,
    externalTransactionId: externalTransactionId as string,
    playerId: playerId as string,
    walletId: walletId as string,
    roundId: roundId as string,
    gameId: gameId as string,
    kind: kind as WagerTransactionKind,
    money: amount as Money,
    referenceExternalTransactionId,
    correlationId: metadata.correlationId,
    causationId: metadata.causationId,
    inbox: metadata.inbox,
  };
}
