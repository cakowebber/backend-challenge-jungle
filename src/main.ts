import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_LOGGER } from './application/ports/observability';
import { loadEnv } from './infrastructure/config/env';
import { JsonLogger, NestLoggerAdapter } from './infrastructure/observability/json-logger';

try {
  // Variável obrigatória ausente derruba o processo aqui, antes de abrir a porta.
  const env = loadEnv();

  // bufferLogs: o Nest segura os próprios logs até receber o logger da
  // aplicação, para que TODA linha do stdout saia no mesmo formato JSON.
  const app = await NestFactory.create(AppModule.forRoot(env), { bufferLogs: true, abortOnError: false });
  app.useLogger(new NestLoggerAdapter(app.get<JsonLogger>(APP_LOGGER)));

  // Faz o Nest ouvir SIGTERM/SIGINT e rodar os hooks de shutdown (parar o
  // consumer e os workers, devolver mensagens em andamento, fechar o pool).
  app.enableShutdownHooks();

  await app.listen(env.port, '0.0.0.0');
} catch (error) {
  // Falha ao subir (configuração inválida, banco inalcançável): mesma linha
  // JSON dos demais logs, e saída com erro para o orquestrador reiniciar.
  new JsonLogger({ level: 'error', base: { service: 'wagering-processor' } }).error('falha ao iniciar a aplicação', {
    reason: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
}
