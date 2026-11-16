import { Controller, Get, Header, Inject } from '@nestjs/common';
import { METRICS } from '../../application/ports/observability';
import { OperationalGauges } from '../../infrastructure/observability/operational-gauges';
import { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics';

@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(METRICS) private readonly metrics: PrometheusMetrics,
    private readonly gauges: OperationalGauges,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return this.metrics.render(await this.gauges.collect());
  }
}
