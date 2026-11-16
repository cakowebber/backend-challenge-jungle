import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_LOGGER } from './application/ports/observability';
import { loadEnv } from './infrastructure/config/env';
import { JsonLogger, NestLoggerAdapter } from './infrastructure/observability/json-logger';

try {
  const env = loadEnv();

  const app = await NestFactory.create(AppModule.forRoot(env), { bufferLogs: true, abortOnError: false });
  app.useLogger(new NestLoggerAdapter(app.get<JsonLogger>(APP_LOGGER)));

  app.enableShutdownHooks();

  await app.listen(env.port, '0.0.0.0');
} catch (error) {
  new JsonLogger({ level: 'error', base: { service: 'wagering-processor' } }).error('falha ao iniciar a aplicação', {
    reason: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
}
