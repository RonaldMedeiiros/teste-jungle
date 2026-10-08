import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Header, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppMetrics } from '../shared/metrics';

@Controller()
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: AppMetrics,
  ) {}

  @Get('health/live')
  live() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  @Get('health/ready')
  async ready(@Res() response: Response): Promise<void> {
    const database = await this.checkDatabase();

    response.status(database ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: database ? 'ok' : 'unavailable',
      checks: { postgres: database ? 'up' : 'down' },
    });
  }

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return this.metrics.expose();
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.orm.em.getConnection().execute('select 1');
      return true;
    } catch {
      return false;
    }
  }
}
