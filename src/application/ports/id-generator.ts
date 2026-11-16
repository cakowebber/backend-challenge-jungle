/** Gerador de ids internos (UUIDv7 na implementação real). */
export interface IdGenerator {
  next(): string;
}

export const ID_GENERATOR = Symbol('ID_GENERATOR');
