import { describe, expect, test } from 'bun:test';
import type { AppLogger } from '../../application/ports/observability';
import { PollingLoop, type TickResult } from './polling-loop';

function silentLogger(warnings: string[] = []): AppLogger {
  return { info: () => undefined, warn: (message) => void warnings.push(message), error: () => undefined };
}

/** Espera uma condição, sondando rápido. */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condição não atingida');
    }
    await Bun.sleep(2);
  }
}

describe('PollingLoop', () => {
  test('MORE roda o próximo ciclo sem esperar o intervalo', async () => {
    let ticks = 0;
    const loop = new PollingLoop('teste', 60_000, async () => (++ticks < 5 ? 'MORE' : 'IDLE'), silentLogger());

    loop.start();
    await until(() => ticks === 5); // com intervalo de 60s, só chega a 5 se não esperou entre os ciclos
    await loop.stop();

    expect(ticks).toBe(5);
  });

  test('IDLE espera o intervalo antes do próximo ciclo', async () => {
    let ticks = 0;
    const loop = new PollingLoop('teste', 40, async () => (ticks++, 'IDLE'), silentLogger());

    loop.start();
    await until(() => ticks === 1);
    await Bun.sleep(10);
    expect(ticks).toBe(1); // ainda dormindo
    await until(() => ticks >= 2);
    await loop.stop();
  });

  test('um ciclo que lança não derruba o laço', async () => {
    let ticks = 0;
    const warnings: string[] = [];
    const loop = new PollingLoop(
      'teste',
      5,
      async (): Promise<TickResult> => {
        if (++ticks === 1) {
          throw new Error('banco fora');
        }
        return 'IDLE';
      },
      silentLogger(warnings),
    );

    loop.start();
    await until(() => ticks >= 2);
    await loop.stop();

    expect(warnings).toEqual(['teste: ciclo falhou']);
  });

  test('stop aguarda o ciclo em curso terminar', async () => {
    let finishTick!: () => void;
    let inTick = false;
    let completed = 0;
    const loop = new PollingLoop(
      'teste',
      60_000,
      async () => {
        inTick = true;
        await new Promise<void>((resolve) => (finishTick = resolve));
        completed += 1;
        return 'IDLE';
      },
      silentLogger(),
    );

    loop.start();
    await until(() => inTick);
    let stopped = false;
    const stopping = loop.stop().then(() => (stopped = true));
    await Bun.sleep(20);
    expect(stopped).toBe(false); // o ciclo ainda não terminou: stop espera por ele

    finishTick();
    await stopping;
    expect(completed).toBe(1);
    expect(loop.isRunning).toBe(false);
  });

  test('stop durante a espera entre ciclos retorna na hora', async () => {
    let ticks = 0;
    const loop = new PollingLoop('teste', 60_000, async () => (ticks++, 'IDLE'), silentLogger());

    loop.start();
    await until(() => ticks === 1); // agora o laço está dormindo os 60s
    const startedAt = Date.now();
    await loop.stop();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(ticks).toBe(1);
  });

  test('start é idempotente e stop sem start não faz nada', async () => {
    let ticks = 0;
    const loop = new PollingLoop('teste', 60_000, async () => (ticks++, 'IDLE'), silentLogger());

    await loop.stop();
    loop.start();
    loop.start();
    await until(() => ticks === 1);
    await Bun.sleep(10);
    await loop.stop();

    expect(ticks).toBe(1); // um laço só
  });
});
