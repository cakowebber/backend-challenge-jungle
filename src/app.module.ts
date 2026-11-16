import { Module, type DynamicModule, type MiddlewareConsumer, type NestModule, type Provider } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApplyWagerTransaction, REFERENCE_RETRY_POLICY } from './application/apply-wager-transaction';
import { CreateWallet } from './application/create-wallet';
import { CLOCK } from './application/ports/clock';
import { EVENT_PUBLISHER } from './application/ports/event-publisher';
import { ID_GENERATOR } from './application/ports/id-generator';
import { APP_LOGGER, METRICS } from './application/ports/observability';
import {
  INBOX_REPOSITORY,
  LEDGER_REPOSITORY,
  OUTBOX_REPOSITORY,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY,
} from './application/ports/repositories';
import { UNIT_OF_WORK } from './application/ports/unit-of-work';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import {
  OUTBOX_PUBLISH_SETTINGS,
  PublishOutboxBatch,
  type OutboxPublishSettings,
} from './application/publish-outbox-batch';
import { TransactionQueries, WalletQueries } from './application/queries';
import { ReconcileWallet } from './application/reconcile-wallet';
import { RecordFailedTransaction } from './application/record-failed-transaction';
import { RetryPendingReferences } from './application/retry-pending-references';
import type { ReferenceRetryPolicy } from './domain/backoff';
import { ENV, type Env } from './infrastructure/config/env';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager-consumer';
import { WagerMessageHandler } from './infrastructure/messaging/wager-message-handler';
import { OutboxPublisherWorker } from './infrastructure/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { ApiExceptionFilter } from './interface/http/api-exception.filter';
import { HealthController } from './interface/http/health.controller';
import { HttpObservabilityMiddleware } from './interface/http/http-observability.middleware';
import { MetricsController } from './interface/http/metrics.controller';
import { WageringController } from './interface/http/wagering.controller';
import { WalletsController } from './interface/http/wallets.controller';

/**
 * Os use cases não conhecem o Nest (sem decorators): são classes comuns,
 * montadas aqui com as portas que cada um recebe no construtor.
 */
const useCases: Provider[] = [
  {
    provide: REFERENCE_RETRY_POLICY,
    inject: [ENV],
    useFactory: (env: Env): ReferenceRetryPolicy => ({
      baseDelayMs: env.pendingReference.retryBaseDelayMs,
      maxDelayMs: env.pendingReference.retryMaxDelayMs,
      maxAttempts: env.pendingReference.maxAttempts,
    }),
  },
  {
    provide: OUTBOX_PUBLISH_SETTINGS,
    inject: [ENV],
    useFactory: (env: Env): OutboxPublishSettings => ({
      batchSize: env.outbox.batchSize,
      retry: { baseDelayMs: env.outbox.retryBaseDelayMs, maxDelayMs: env.outbox.retryMaxDelayMs },
    }),
  },
  {
    provide: ApplyWagerTransaction,
    inject: [
      WALLET_REPOSITORY,
      WAGER_TRANSACTION_REPOSITORY,
      LEDGER_REPOSITORY,
      OUTBOX_REPOSITORY,
      ID_GENERATOR,
      REFERENCE_RETRY_POLICY,
    ],
    useFactory: (...deps: ConstructorParameters<typeof ApplyWagerTransaction>) => new ApplyWagerTransaction(...deps),
  },
  {
    provide: ProcessWagerTransaction,
    inject: [
      UNIT_OF_WORK,
      WALLET_REPOSITORY,
      WAGER_TRANSACTION_REPOSITORY,
      INBOX_REPOSITORY,
      ApplyWagerTransaction,
      ID_GENERATOR,
      CLOCK,
      METRICS,
      APP_LOGGER,
    ],
    useFactory: (...deps: ConstructorParameters<typeof ProcessWagerTransaction>) =>
      new ProcessWagerTransaction(...deps),
  },
  {
    provide: RecordFailedTransaction,
    inject: [
      UNIT_OF_WORK,
      WALLET_REPOSITORY,
      WAGER_TRANSACTION_REPOSITORY,
      INBOX_REPOSITORY,
      OUTBOX_REPOSITORY,
      ID_GENERATOR,
      CLOCK,
      METRICS,
    ],
    useFactory: (...deps: ConstructorParameters<typeof RecordFailedTransaction>) =>
      new RecordFailedTransaction(...deps),
  },
  {
    provide: PublishOutboxBatch,
    inject: [UNIT_OF_WORK, OUTBOX_REPOSITORY, EVENT_PUBLISHER, CLOCK, METRICS, OUTBOX_PUBLISH_SETTINGS],
    useFactory: (...deps: ConstructorParameters<typeof PublishOutboxBatch>) => new PublishOutboxBatch(...deps),
  },
  {
    provide: RetryPendingReferences,
    inject: [
      UNIT_OF_WORK,
      WALLET_REPOSITORY,
      WAGER_TRANSACTION_REPOSITORY,
      ApplyWagerTransaction,
      ID_GENERATOR,
      CLOCK,
      METRICS,
      APP_LOGGER,
    ],
    useFactory: (...deps: ConstructorParameters<typeof RetryPendingReferences>) =>
      new RetryPendingReferences(...deps),
  },
  {
    provide: CreateWallet,
    inject: [
      UNIT_OF_WORK,
      WALLET_REPOSITORY,
      WAGER_TRANSACTION_REPOSITORY,
      LEDGER_REPOSITORY,
      OUTBOX_REPOSITORY,
      ID_GENERATOR,
      CLOCK,
    ],
    useFactory: (...deps: ConstructorParameters<typeof CreateWallet>) => new CreateWallet(...deps),
  },
  {
    provide: ReconcileWallet,
    inject: [UNIT_OF_WORK, WALLET_REPOSITORY, METRICS, APP_LOGGER],
    useFactory: (...deps: ConstructorParameters<typeof ReconcileWallet>) => new ReconcileWallet(...deps),
  },
  {
    provide: WalletQueries,
    inject: [UNIT_OF_WORK, WALLET_REPOSITORY, LEDGER_REPOSITORY],
    useFactory: (...deps: ConstructorParameters<typeof WalletQueries>) => new WalletQueries(...deps),
  },
  {
    provide: TransactionQueries,
    inject: [UNIT_OF_WORK, WAGER_TRANSACTION_REPOSITORY],
    useFactory: (...deps: ConstructorParameters<typeof TransactionQueries>) => new TransactionQueries(...deps),
  },
];

@Module({})
export class AppModule implements NestModule {
  /** Correlação, latência e log de acesso em todas as rotas HTTP. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpObservabilityMiddleware).forRoutes('{*path}');
  }

  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [InfrastructureModule.forRoot(env)],
      controllers: [HealthController, MetricsController, WalletsController, WageringController],
      providers: [
        ...useCases,
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        // Segunda porta de entrada: a fila chama os mesmos use cases do HTTP.
        WagerMessageHandler,
        SqsWagerConsumer,
        // Workers em segundo plano: publicação da outbox e reprocessamento de PENDING_REFERENCE.
        OutboxPublisherWorker,
        PendingReferenceWorker,
      ],
    };
  }
}
