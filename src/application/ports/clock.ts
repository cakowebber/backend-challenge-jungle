/** Relógio injetável: o domínio e os use cases nunca leem a hora diretamente. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');
