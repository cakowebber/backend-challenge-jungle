export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export interface GateDelays {
  baseMs: number;
  maxMs: number;
}

export class ConsumptionGate {
  private closed = false;
  private reopening: Promise<void> | undefined;

  constructor(
    private readonly isHealthy: () => Promise<boolean>,
    private readonly delays: GateDelays = { baseMs: 1_000, maxMs: 15_000 },
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }

  async waitUntilOpen(signal: AbortSignal): Promise<void> {
    if (!this.closed) {
      return;
    }
    this.reopening ??= this.probeUntilHealthy(signal).finally(() => {
      this.reopening = undefined;
    });
    await this.reopening;
  }

  private async probeUntilHealthy(signal: AbortSignal): Promise<void> {
    for (let attempt = 0; !signal.aborted; attempt++) {
      if (await this.isHealthy().catch(() => false)) {
        this.closed = false;
        return;
      }
      await this.sleep(Math.min(this.delays.baseMs * 2 ** Math.min(attempt, 20), this.delays.maxMs), signal);
    }
  }
}
