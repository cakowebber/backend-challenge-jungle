export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface FieldError {
  field: string;
  message: string;
}

export class InvalidRequestError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';

  constructor(public readonly details: readonly FieldError[]) {
    super(`Requisição inválida: ${details.map((d) => `${d.field}: ${d.message}`).join('; ')}`);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(idempotencyKey: string) {
    super(`A idempotency key "${idempotencyKey}" já foi usada com um payload diferente`);
  }
}

export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_ID_CONFLICT';

  constructor(providerId: string, externalTransactionId: string) {
    super(
      `A transação "${externalTransactionId}" do provedor "${providerId}" já existe com outra idempotency key`,
    );
  }
}

export class MessageIdConflictError extends ApplicationError {
  readonly code = 'MESSAGE_ID_CONFLICT';

  constructor(messageId: string) {
    super(`A mensagem "${messageId}" já foi recebida com um conteúdo diferente`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`O player "${playerId}" já tem uma wallet em ${currency}`);
  }
}

export class WalletNotFoundForTransactionError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
  readonly failureCode = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet "${walletId}" não existe`);
  }
}

export class ResourceNotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';

  constructor(resource: string, id: string) {
    super(`${resource} "${id}" não encontrado(a)`);
  }
}

export class UnauthenticatedError extends ApplicationError {
  readonly code = 'UNAUTHENTICATED';

  constructor(reason: string) {
    super(`Credencial ausente ou inválida: ${reason}`);
  }
}

export class ProviderNotAllowedError extends ApplicationError {
  readonly code = 'PROVIDER_NOT_ALLOWED';

  constructor(authenticatedProviderId: string, requestedProviderId: string) {
    super(`O provedor "${authenticatedProviderId}" não pode agir em nome de "${requestedProviderId}"`);
  }
}

export type TransientReason = 'LOCK_TIMEOUT' | 'DEADLOCK' | 'DATABASE_UNAVAILABLE' | 'CONCURRENT_UPDATE';

export class TransientFailureError extends ApplicationError {
  readonly code = 'TRANSIENT_FAILURE';

  constructor(
    public readonly reason: TransientReason,
    options?: ErrorOptions,
  ) {
    super(`Falha transitória (${reason}); a operação pode ser reenviada`, options);
  }
}
