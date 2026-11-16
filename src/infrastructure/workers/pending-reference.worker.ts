import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_LOGGER, type AppLogger } from '../../application/ports/observability';
import { RetryPendingReferences } from '../../application/retry-pending-references';
import { ENV, type Env } from '../config/env';
import { PollingLoop } from './polling-loop';

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    retryPendingReferences: RetryPendingReferences,
    @Inject(ENV) private readonly env: Env,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.loop = new PollingLoop(
      'pending-reference-worker',
      env.pendingReference.pollIntervalMs,
      async () => {
        const result = await retryPendingReferences.execute(env.pendingReference.batchSize);
        return result.found === env.pendingReference.batchSize && result.outcomes.ERRORED === 0 ? 'MORE' : 'IDLE';
      },
      logger,
    );
  }

  get isRunning(): boolean {
    return this.loop.isRunning;
  }

  onApplicationBootstrap(): void {
    if (this.env.pendingReference.enabled) {
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
