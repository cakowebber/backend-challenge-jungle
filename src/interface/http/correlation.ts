import type { IdGenerator } from '../../application/ports/id-generator';

/** O mínimo que os controllers usam do objeto de resposta, sem depender dos tipos do Express. */
export interface HttpResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/** Requisição depois do HttpObservabilityMiddleware: o correlationId já está resolvido. */
export interface CorrelatedRequest {
  correlationId?: string;
}

const MAX_CORRELATION_ID_LENGTH = 128;
const SAFE_CORRELATION_ID = /^[\w.:-]+$/;

/**
 * Usa o X-Correlation-Id do chamador quando ele é bem formado; senão gera um.
 * O id acompanha a requisição até os eventos e os logs.
 */
export function correlationIdFrom(header: unknown, ids: IdGenerator): string {
  if (
    typeof header === 'string' &&
    header.length <= MAX_CORRELATION_ID_LENGTH &&
    SAFE_CORRELATION_ID.test(header)
  ) {
    return header;
  }
  return ids.next();
}

/**
 * O correlationId da requisição, resolvido UMA vez pelo middleware. Os
 * controllers, o filtro de erros e o log de acesso usam todos o mesmo valor.
 */
export function correlationIdOf(request: CorrelatedRequest): string {
  if (request.correlationId === undefined) {
    throw new Error('correlationId ausente: o HttpObservabilityMiddleware não rodou nesta rota');
  }
  return request.correlationId;
}
