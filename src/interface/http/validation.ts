import type { CreateWalletCommand } from '../../application/create-wallet';
import {
  asObject,
  money,
  parseWagerTransactionInput,
  Problems,
  text,
  uuid,
} from '../../application/input-validation';
import type { ProcessWagerTransactionCommand } from '../../application/process-wager-transaction';
import { LEDGER_DEFAULT_LIMIT, LEDGER_MAX_LIMIT } from '../../application/queries';
import type { Money } from '../../domain/money';

/** Parsers das entradas HTTP. As regras de cada campo ficam em application/input-validation. */

/** Parâmetro de rota que identifica um recurso interno. */
export function parseUuidParam(value: string, name: string): string {
  const problems = new Problems();
  const parsed = uuid(value, name, problems);
  problems.throwIfAny();
  return parsed as string;
}

export function parseTextParam(value: string, name: string): string {
  const problems = new Problems();
  const parsed = text(value, name, problems);
  problems.throwIfAny();
  return parsed as string;
}

export function parseCreateWallet(body: unknown, correlationId: string): CreateWalletCommand {
  const problems = new Problems();
  const input = asObject(body, 'body', problems);

  const playerId = text(input.playerId, 'playerId', problems);
  const initialBalance = money(input.initialBalance, 'initialBalance', problems);

  problems.throwIfAny();
  return { playerId: playerId as string, initialBalance: initialBalance as Money, correlationId };
}

/** Corpo de POST /wagering/transactions. A idempotency key vem do header. */
export function parseSubmitTransaction(
  body: unknown,
  metadata: { idempotencyKey: unknown; correlationId: string },
): ProcessWagerTransactionCommand {
  return parseWagerTransactionInput(body, {
    idempotencyKey: metadata.idempotencyKey,
    idempotencyKeyField: 'Idempotency-Key',
    correlationId: metadata.correlationId,
    causationId: undefined,
    inbox: undefined,
  });
}

export function parseLedgerQuery(query: { cursor?: unknown; limit?: unknown }): {
  cursor: string | undefined;
  limit: number;
} {
  const problems = new Problems();

  let limit = LEDGER_DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit) || limit < 1 || limit > LEDGER_MAX_LIMIT) {
      problems.add('limit', `deve ser um inteiro entre 1 e ${LEDGER_MAX_LIMIT}`);
    }
  }

  let cursor: string | undefined;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || query.cursor === '') {
      problems.add('cursor', 'cursor inválido');
    } else {
      cursor = query.cursor;
    }
  }

  problems.throwIfAny();
  return { cursor, limit };
}
