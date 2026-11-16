export interface UnitOfWork {
  transactional<T>(work: () => Promise<T>): Promise<T>;

  session<T>(work: () => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
