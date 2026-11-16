import type { IdGenerator } from '../../application/ports/id-generator';

export interface HttpResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

export interface CorrelatedRequest {
  correlationId?: string;
}

const MAX_CORRELATION_ID_LENGTH = 128;
const SAFE_CORRELATION_ID = /^[\w.:-]+$/;

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

export function correlationIdOf(request: CorrelatedRequest): string {
  if (request.correlationId === undefined) {
    throw new Error('correlationId ausente: o HttpObservabilityMiddleware não rodou nesta rota');
  }
  return request.correlationId;
}
