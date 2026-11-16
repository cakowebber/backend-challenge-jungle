import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { ID_GENERATOR, type IdGenerator } from '../../application/ports/id-generator';
import { APP_LOGGER, METRICS, MetricName, type AppLogger, type Metrics } from '../../application/ports/observability';
import { correlationIdFrom, type CorrelatedRequest } from './correlation';

/** O mínimo que o middleware usa do Express, sem depender dos tipos dele. */
interface IncomingRequest extends CorrelatedRequest {
  method: string;
  originalUrl: string;
  headers: Record<string, unknown>;
  /** Preenchido pelo Express quando uma rota casa: o padrão, ex. "/wallets/:walletId". */
  route?: { path?: string };
}

interface OutgoingResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  on(event: 'finish', listener: () => void): unknown;
}

/** Sondas e scrapes chegam a cada poucos segundos: medidos, mas fora do log de acesso. */
const QUIET_PATHS = /^\/(health|metrics)(\/|$)/;

/**
 * Primeira coisa a rodar em toda requisição HTTP:
 *
 *  - resolve o correlationId (o do chamador, se bem formado; senão um novo) e
 *    o devolve no header X-Correlation-Id de TODA resposta, inclusive erro;
 *  - ao fim da resposta, registra a latência e uma linha de log de acesso.
 *
 * A latência usa o PADRÃO da rota como label ("/wallets/:walletId"), nunca a
 * URL: um label por id criaria uma série de métrica por wallet.
 */
@Injectable()
export class HttpObservabilityMiddleware implements NestMiddleware {
  constructor(
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  use(request: IncomingRequest, response: OutgoingResponse, next: () => void): void {
    const startedAt = performance.now();
    const correlationId = correlationIdFrom(request.headers['x-correlation-id'], this.ids);
    request.correlationId = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);

    response.on('finish', () => {
      const seconds = (performance.now() - startedAt) / 1000;
      const status = response.statusCode;
      const route = request.route?.path ?? 'unmatched';
      this.metrics.observe(MetricName.HttpRequestDuration, seconds, {
        method: request.method,
        route,
        status: String(status),
      });

      const path = request.originalUrl.split('?')[0] ?? '';
      if (QUIET_PATHS.test(path)) {
        return;
      }
      const fields = {
        correlationId,
        method: request.method,
        path,
        route,
        status,
        durationMs: Math.round(seconds * 1000),
      };
      if (status >= 500) {
        this.logger.warn('requisição http', fields);
      } else {
        this.logger.info('requisição http', fields);
      }
    });

    next();
  }
}
