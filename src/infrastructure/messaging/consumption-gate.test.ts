import { describe, expect, test } from 'bun:test';
import { abortableSleep, ConsumptionGate } from './consumption-gate';

function recordingSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

describe('ConsumptionGate', () => {
  test('aberto: deixa passar na hora, sem sondar a dependência', async () => {
    let probes = 0;
    const gate = new ConsumptionGate(async () => (probes += 1) > 0);

    await gate.waitUntilOpen(new AbortController().signal);

    expect(gate.isClosed).toBe(false);
    expect(probes).toBe(0);
  });

  test('fechado: só reabre quando a dependência volta, sondando com backoff até o teto', async () => {
    const answers = [false, false, false, false, false, true];
    const { delays, sleep } = recordingSleep();
    const gate = new ConsumptionGate(async () => answers.shift() ?? true, { baseMs: 1_000, maxMs: 5_000 }, sleep);

    gate.close();
    expect(gate.isClosed).toBe(true);
    await gate.waitUntilOpen(new AbortController().signal);

    expect(gate.isClosed).toBe(false);
    expect(delays).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
  });

  test('vários workers esperando compartilham a mesma sondagem', async () => {
    let probes = 0;
    let recover!: () => void;
    const recovered = new Promise<void>((resolve) => (recover = resolve));
    const gate = new ConsumptionGate(
      async () => {
        probes += 1;
        await recovered;
        return true;
      },
      { baseMs: 1, maxMs: 1 },
    );
    gate.close();
    const signal = new AbortController().signal;

    const workers = [gate.waitUntilOpen(signal), gate.waitUntilOpen(signal), gate.waitUntilOpen(signal)];
    recover();
    await Promise.all(workers);

    expect(probes).toBe(1);
    expect(gate.isClosed).toBe(false);
  });

  test('sondagem que lança conta como dependência fora do ar', async () => {
    const outcomes: (() => Promise<boolean>)[] = [
      () => Promise.reject(new Error('conexão recusada')),
      () => Promise.resolve(true),
    ];
    const { delays, sleep } = recordingSleep();
    const gate = new ConsumptionGate(() => (outcomes.shift() as () => Promise<boolean>)(), { baseMs: 10, maxMs: 10 }, sleep);
    gate.close();

    await gate.waitUntilOpen(new AbortController().signal);

    expect(delays).toEqual([10]);
    expect(gate.isClosed).toBe(false);
  });

  test('shutdown durante a espera: retorna, mas o portão continua fechado', async () => {
    const controller = new AbortController();
    const gate = new ConsumptionGate(async () => false, { baseMs: 60_000, maxMs: 60_000 });
    gate.close();

    const waiting = gate.waitUntilOpen(controller.signal);
    controller.abort();
    await waiting;

    expect(gate.isClosed).toBe(true);
  });

  test('pode fechar de novo depois de reaberto', async () => {
    const gate = new ConsumptionGate(async () => true, { baseMs: 1, maxMs: 1 });
    const signal = new AbortController().signal;

    gate.close();
    await gate.waitUntilOpen(signal);
    gate.close();

    expect(gate.isClosed).toBe(true);
    await gate.waitUntilOpen(signal);
    expect(gate.isClosed).toBe(false);
  });
});

describe('abortableSleep', () => {
  test('termina antes quando o sinal é abortado', async () => {
    const controller = new AbortController();
    const started = performance.now();

    const sleeping = abortableSleep(5_000, controller.signal);
    controller.abort();
    await sleeping;

    expect(performance.now() - started).toBeLessThan(500);
  });

  test('com sinal já abortado, nem espera', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = performance.now();

    await abortableSleep(5_000, controller.signal);

    expect(performance.now() - started).toBeLessThan(100);
  });
});
