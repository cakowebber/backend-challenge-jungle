export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(reason: string) {
    super(`Valor monetário inválido: ${reason}`);
  }
}

export class DomainValidationError extends DomainError {
  readonly code = 'DOMAIN_VALIDATION';

  constructor(
    public readonly field: string,
    reason: string,
  ) {
    super(`${field}: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`Operação entre moedas diferentes: esperado ${expected}, recebido ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(walletId: string) {
    super(`Saldo insuficiente na wallet ${walletId}`);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';

  constructor(reason: string) {
    super(`Lançamento de ledger inconsistente: ${reason}`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(transactionId: string, currentStatus: string, attempted: string) {
    super(`Transação ${transactionId} está em ${currentStatus} e não aceita ${attempted}`);
  }
}

export class DomainInvariantError extends DomainError {
  readonly code = 'DOMAIN_INVARIANT_VIOLATION';

  constructor(reason: string) {
    super(`Invariante de domínio violada: ${reason}`);
  }
}

export function requireNonEmpty(field: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainValidationError(field, 'é obrigatório');
  }
  return value;
}
