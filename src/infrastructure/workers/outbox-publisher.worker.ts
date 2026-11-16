import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_LOGGER, type AppLogger } from '../../application/ports/observability';
import { PublishOutboxBatch } from '../../application/publish-outbox-batch';
import { ENV, type Env } from '../config/env';
import { PollingLoop } from './polling-loop';

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    publishOutboxBatch: PublishOutboxBatch,
    @Inject(ENV) private readonly env: Env,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.loop = new PollingLoop(
      'outbox-publisher',
      env.outbox.pollIntervalMs,
      async () => {
        const result = await publishOutboxBatch.execute();
        if (result.failed > 0) {
          logger.warn('outbox-publisher: publicações falharam e serão repetidas', { failed: result.failed });
        }
        return result.claimed === env.outbox.batchSize && result.failed === 0 ? 'MORE' : 'IDLE';
      },
      logger,
    );
  }

  get isRunning(): boolean {
    return this.loop.isRunning;
  }

  onApplicationBootstrap(): void {
    if (this.env.outbox.enabled) {
      this.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}
