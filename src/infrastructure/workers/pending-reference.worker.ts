import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_LOGGER, type AppLogger } from '../../application/ports/observability';
import { RetryPendingReferences } from '../../application/retry-pending-references';
import { ENV, type Env } from '../config/env';
import { PollingLoop } from './polling-loop';

/**
 * Worker agendado de PENDING_REFERENCE: a cada intervalo, reprocessa os
 * REFUND/ROLLBACK cuja próxima tentativa venceu. Toda instância roda um; a
 * mesma transação nunca é aplicada duas vezes porque cada tentativa trava a
 * wallet e relê o estado (ver RetryPendingReferences).
 */
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
        // Lote cheio e sem erro: ainda há vencidas esperando. Com erro, espera
        // o intervalo para não girar em falso sobre a mesma transação.
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

  /** Antes de o pool do banco fechar: a tentativa em curso termina o seu commit. */
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
