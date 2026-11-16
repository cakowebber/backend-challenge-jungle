import { InvalidRequestError } from '../../application/errors';
import { asObject, parseWagerTransactionInput, Problems, text } from '../../application/input-validation';
import type { ProcessWagerTransactionCommand } from '../../application/process-wager-transaction';

/** Nome deste consumidor na inbox: a deduplicação é por (consumerName, messageId). */
export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

/**
 * Converte o corpo de uma mensagem da fila no MESMO comando que o HTTP monta:
 *
 *   { messageId, type: "WagerTransactionRequested", occurredAt, data: { idempotencyKey, ...payload } }
 *
 * - `messageId` (do corpo, não o do SQS) identifica a mensagem na inbox: ele
 *   não muda quando o produtor reenvia a mesma mensagem.
 * - `data` tem os mesmos campos do POST /wagering/transactions e passa pela
 *   mesma validação; a idempotency key vem dentro dele.
 * - a mensagem inicia a cadeia de rastreio: messageId vira correlationId e
 *   causationId dos eventos.
 *
 * Qualquer problema lança InvalidRequestError: mensagem malformada não melhora
 * com retry, então é erro permanente.
 */
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

  // Valida o payload junto com o envelope, para o motivo listar tudo de uma vez.
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
