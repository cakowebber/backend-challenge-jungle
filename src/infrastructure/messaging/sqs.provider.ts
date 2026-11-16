import { SQSClient } from '@aws-sdk/client-sqs';
import type { FactoryProvider } from '@nestjs/common';
import { ENV, type Env } from '../config/env';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export const sqsClientProvider: FactoryProvider<SQSClient> = {
  provide: SQS_CLIENT,
  inject: [ENV],
  useFactory: (env: Env) =>
    new SQSClient({
      region: env.awsRegion,
      ...(env.sqsEndpoint === undefined ? {} : { endpoint: env.sqsEndpoint }),
    }),
};
