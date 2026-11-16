import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { ID_GENERATOR, type IdGenerator } from '../../application/ports/id-generator';
import { APP_LOGGER, METRICS, MetricName, type AppLogger, type Metrics } from '../../application/ports/observability';
import { correlationIdFrom, type CorrelatedRequest } from './correlation';

interface IncomingRequest extends CorrelatedRequest {
  method: string;
  originalUrl: string;
  headers: Record<string, unknown>;
  route?: { path?: string };
}

interface OutgoingResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  on(event: 'finish', listener: () => void): unknown;
}

const QUIET_PATHS = /^\/(health|metrics)(\/|$)/;

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
