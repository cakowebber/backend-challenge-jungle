import { SQSClient } from '@aws-sdk/client-sqs';
import type { FactoryProvider } from '@nestjs/common';
import { ENV, type Env } from '../config/env';

/** Token de injeção do cliente SQS (um por processo, reaproveita conexões). */
export const SQS_CLIENT = Symbol('SQS_CLIENT');

export const sqsClientProvider: FactoryProvider<SQSClient> = {
  provide: SQS_CLIENT,
  inject: [ENV],
  useFactory: (env: Env) =>
    new SQSClient({
      region: env.awsRegion,
      // Com `endpoint` definido (LocalStack), o SDK envia tudo para ele e trata a
      // QueueUrl só como identificador da fila — não tenta resolver o host dela.
      // Sem `endpoint` (AWS real), usa a própria QueueUrl. Credenciais vêm do
      // ambiente (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY), como em produção.
      ...(env.sqsEndpoint === undefined ? {} : { endpoint: env.sqsEndpoint }),
    }),
};
