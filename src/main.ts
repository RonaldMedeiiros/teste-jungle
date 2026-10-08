import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ErrorFilter } from './shared/error.filter';
import { AppLogger } from './shared/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();

  const logger = app.get(AppLogger);
  app.useGlobalFilters(new ErrorFilter(logger));

  const port = Number.parseInt(process.env['HTTP_PORT'] ?? '3000', 10);
  await app.listen(port, '0.0.0.0');

  logger.info('service listening', { port, instanceId: process.env['INSTANCE_ID'] ?? 'local' });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutdown signal received', { signal });
    try {
      await app.close();
      await app.get(MikroORM).close(true);
    } catch (error) {
      logger.error('shutdown failed', { error: error instanceof Error ? error.message : 'unknown error' });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
