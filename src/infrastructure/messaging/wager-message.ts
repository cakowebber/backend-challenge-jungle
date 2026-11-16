import { InvalidRequestError } from '../../application/errors';
import { asObject, parseWagerTransactionInput, Problems, text } from '../../application/input-validation';
import type { ProcessWagerTransactionCommand } from '../../application/process-wager-transaction';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

export function parseWagerMessage(body: string): ProcessWagerTransactionCommand {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new InvalidRequestError([{ field: 'body', message: 'não é um JSON válido' }]);
  }

  const problems = new Problems();
  const fields = asObject(envelope, 'body', problems);

  const messageId = text(fields.messageId, 'messageId', problems);
  if (fields.type !== WAGER_MESSAGE_TYPE) {
    problems.add('type', `deve ser "${WAGER_MESSAGE_TYPE}"`);
  }
  if (typeof fields.occurredAt !== 'string' || Number.isNaN(Date.parse(fields.occurredAt))) {
    problems.add('occurredAt', 'deve ser uma data ISO-8601');
  }
  const data = asObject(fields.data, 'data', problems);

  return parseWagerTransactionInput(
    data,
    {
      idempotencyKey: data.idempotencyKey,
      idempotencyKeyField: 'data.idempotencyKey',
      correlationId: messageId ?? 'invalid',
      causationId: messageId,
      inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: messageId ?? 'invalid' },
    },
    problems,
    'data.',
  );
}
