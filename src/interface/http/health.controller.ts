import { Controller, Get, Res } from '@nestjs/common';
import { ReadinessService, type ReadinessReport } from '../../infrastructure/health/readiness.service';
import type { HttpResponse } from './correlation';

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
