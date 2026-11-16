import type { Clock } from '../application/ports/clock';
import type { IdGenerator } from '../application/ports/id-generator';

/** Implementações simples das portas de apoio. */

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: ordenável por tempo, o que mantém os índices de PK compactos. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
