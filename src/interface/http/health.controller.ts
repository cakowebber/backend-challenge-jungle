import { Controller, Get, Res } from '@nestjs/common';
import { ReadinessService, type ReadinessReport } from '../../infrastructure/health/readiness.service';
import type { HttpResponse } from './correlation';

/**
 * Health checks abertos (sem autenticação, desafio seção 2).
 * - live: o processo responde. Não toca em dependência nenhuma, para que uma
 *   queda do Postgres não faça o orquestrador reiniciar instâncias saudáveis.
 * - ready: Postgres e SQS alcançáveis. 503 tira a instância do balanceamento.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: HttpResponse): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    response.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
