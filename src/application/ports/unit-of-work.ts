/**
 * Fronteira transacional. Os repositórios não recebem transação por parâmetro:
 * tudo que rodar dentro de `transactional` participa da mesma transação SQL.
 */
export interface UnitOfWork {
  /**
   * Executa `work` em UMA transação SQL: commit se resolver, rollback se lançar.
   * Erros transitórios do banco saem como TransientFailureError.
   */
  transactional<T>(work: () => Promise<T>): Promise<T>;

  /** Contexto para leituras sem transação (cada comando enxerga o que já foi commitado). */
  session<T>(work: () => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
