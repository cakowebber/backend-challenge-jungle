import type { AppLogger } from '../../application/ports/observability';
import { abortableSleep } from '../messaging/consumption-gate';

export type TickResult = 'MORE' | 'IDLE';

const MAX_FAILURE_DELAY_MS = 15_000;

export class PollingLoop {
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<TickResult>,
    private readonly logger: AppLogger,
  ) {}

  get isRunning(): boolean {
    return this.controller !== undefined;
  }

  start(): void {
    if (this.controller !== undefined) {
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.run(controller.signal);
    this.logger.info(`${this.name} iniciado`, { intervalMs: this.intervalMs });
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    if (controller === undefined) {
      return;
    }
    this.controller = undefined;
    controller.abort();
    await this.running;
    this.logger.info(`${this.name} parado`);
  }

  private async run(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      let delayMs = this.intervalMs;
      try {
        const result = await this.tick();
        consecutiveFailures = 0;
        if (result === 'MORE') {
          continue;
        }
      } catch (error) {
        consecutiveFailures += 1;
        delayMs = Math.min(this.intervalMs * 2 ** Math.min(consecutiveFailures, 10), MAX_FAILURE_DELAY_MS);
        this.logger.warn(`${this.name}: ciclo falhou`, {
          reason: error instanceof Error ? error.message : String(error),
          consecutiveFailures,
        });
      }
      await abortableSleep(delayMs, signal);
    }
  }
}
