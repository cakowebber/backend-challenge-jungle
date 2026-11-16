import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { CLOCK } from '../application/ports/clock';
import { EVENT_PUBLISHER } from '../application/ports/event-publisher';
import { ID_GENERATOR } from '../application/ports/id-generator';
import { APP_LOGGER, METRICS } from '../application/ports/observability';
import { PROVIDER_IDENTITY } from '../application/ports/provider-identity';
import {
  INBOX_REPOSITORY,
  LEDGER_REPOSITORY,
  OUTBOX_REPOSITORY,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY,
} from '../application/ports/repositories';
import { UNIT_OF_WORK } from '../application/ports/unit-of-work';
import { OpenProviderIdentity } from './auth/open-provider-identity';
import { ENV, type Env } from './config/env';
import { ReadinessService } from './health/readiness.service';
import { SqsEventPublisher } from './messaging/sqs-event-publisher';
import { SQS_CLIENT, sqsClientProvider } from './messaging/sqs.provider';
import { MikroOrmUnitOfWork } from './persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from './persistence/orm-config';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './persistence/repositories';
import { hostname } from 'node:os';
import { JsonLogger } from './observability/json-logger';
import { OperationalGauges } from './observability/operational-gauges';
import { PrometheusMetrics } from './observability/prometheus-metrics';
import { SystemClock, UuidV7Generator } from './support';

/** Implementações das portas da aplicação. Nenhuma regra de negócio mora aqui. */
@Module({})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  static forRoot(env: Env): DynamicModule {
    return {
      module: InfrastructureModule,
      imports: [
        MikroOrmModule.forRoot({
          ...createOrmConfig({
            url: env.databaseUrl,
            poolMax: env.databasePoolMax,
            lockTimeoutMs: env.databaseLockTimeoutMs,
          }),
          // Sem o middleware de RequestContext: o contexto do EntityManager é
          // sempre aberto de forma explícita pelo UnitOfWork (transactional/session),
          // do mesmo jeito para HTTP, fila e workers.
          registerRequestContext: false,
        }),
      ],
      providers: [
        { provide: ENV, useValue: env },
        sqsClientProvider,
        ReadinessService,
        { provide: UNIT_OF_WORK, useClass: MikroOrmUnitOfWork },
        { provide: WALLET_REPOSITORY, useClass: MikroOrmWalletRepository },
        { provide: WAGER_TRANSACTION_REPOSITORY, useClass: MikroOrmWagerTransactionRepository },
        { provide: LEDGER_REPOSITORY, useClass: MikroOrmLedgerRepository },
        { provide: OUTBOX_REPOSITORY, useClass: MikroOrmOutboxRepository },
        { provide: INBOX_REPOSITORY, useClass: MikroOrmInboxRepository },
        {
          provide: EVENT_PUBLISHER,
          inject: [SQS_CLIENT],
          useFactory: (sqs: SQSClient) => new SqsEventPublisher(sqs, env.eventsQueueUrl, env.outbox.sendTimeoutMs),
        },
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7Generator },
        // Uma instância por processo: os contadores são do processo, e /metrics os expõe.
        { provide: METRICS, useValue: new PrometheusMetrics() },
        {
          provide: APP_LOGGER,
          // `instance` distingue as réplicas quando os logs são agregados (no Docker é o id do container).
          useValue: new JsonLogger({
            level: env.logLevel,
            base: { service: 'wagering-processor', instance: hostname() },
          }),
        },
        OperationalGauges,
        // Ponto de extensão da autenticação: trocar este adaptador no-op pelo do
        // Identity Provider liga a autenticação em todos os endpoints de negócio.
        { provide: PROVIDER_IDENTITY, useClass: OpenProviderIdentity },
      ],
      exports: [
        ENV,
        SQS_CLIENT,
        ReadinessService,
        UNIT_OF_WORK,
        WALLET_REPOSITORY,
        WAGER_TRANSACTION_REPOSITORY,
        LEDGER_REPOSITORY,
        OUTBOX_REPOSITORY,
        INBOX_REPOSITORY,
        EVENT_PUBLISHER,
        CLOCK,
        ID_GENERATOR,
        METRICS,
        APP_LOGGER,
        OperationalGauges,
        PROVIDER_IDENTITY,
      ],
    };
  }

  /** Fecha os sockets do SQS no shutdown; o pool do Postgres é fechado pelo MikroOrmModule. */
  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
