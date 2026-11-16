/**
 * Erros da camada de aplicação. Cada classe corresponde a UMA situação que a
 * API precisa distinguir (desafio 9); a borda HTTP só traduz classe -> status.
 */
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

/** Payload, header, parâmetro ou cursor malformado. -> 400 */
export class InvalidRequestError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';

  constructor(public readonly details: readonly FieldError[]) {
    super(`Requisição inválida: ${details.map((d) => `${d.field}: ${d.message}`).join('; ')}`);
  }
}

/** Mesma idempotency key com payload diferente: conflito, não replay. -> 409 */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(idempotencyKey: string) {
    super(`A idempotency key "${idempotencyKey}" já foi usada com um payload diferente`);
  }
}

/** Mesma operação do provedor reenviada com OUTRA idempotency key. -> 409 */
export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_ID_CONFLICT';

  constructor(providerId: string, externalTransactionId: string) {
    super(
      `A transação "${externalTransactionId}" do provedor "${providerId}" já existe com outra idempotency key`,
    );
  }
}

/**
 * O mesmo messageId chegou de novo pela fila com OUTRO conteúdo. Não é
 * redelivery: é reuso indevido do id. A mensagem vai para a DLQ.
 */
export class MessageIdConflictError extends ApplicationError {
  readonly code = 'MESSAGE_ID_CONFLICT';

  constructor(messageId: string) {
    super(`A mensagem "${messageId}" já foi recebida com um conteúdo diferente`);
  }
}

/** Já existe wallet para o player nesta moeda. -> 409 */
export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`O player "${playerId}" já tem uma wallet em ${currency}`);
  }
}

/**
 * Rejeição de negócio que NÃO vira transação persistida: a wallet não existe,
 * e a FK impede gravar uma transação para ela. -> 422 com failureCode.
 * Nada é gravado, então o provedor pode reenviar o mesmo id depois de criar a wallet.
 */
export class WalletNotFoundForTransactionError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
  readonly failureCode = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet "${walletId}" não existe`);
  }
}

/** Recurso consultado não existe. -> 404 */
export class ResourceNotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';

  constructor(resource: string, id: string) {
    super(`${resource} "${id}" não encontrado(a)`);
  }
}

/**
 * Credencial ausente ou inválida. Só é lançado por um adaptador de Identity
 * Provider; com a autenticação desligada nunca acontece. -> 401
 */
export class UnauthenticatedError extends ApplicationError {
  readonly code = 'UNAUTHENTICATED';

  constructor(reason: string) {
    super(`Credencial ausente ou inválida: ${reason}`);
  }
}

/** Provedor autenticado tentando agir em nome de outro. -> 403 */
export class ProviderNotAllowedError extends ApplicationError {
  readonly code = 'PROVIDER_NOT_ALLOWED';

  constructor(authenticatedProviderId: string, requestedProviderId: string) {
    super(`O provedor "${authenticatedProviderId}" não pode agir em nome de "${requestedProviderId}"`);
  }
}

export type TransientReason = 'LOCK_TIMEOUT' | 'DEADLOCK' | 'DATABASE_UNAVAILABLE' | 'CONCURRENT_UPDATE';

/**
 * Falha transitória de infraestrutura: nada foi gravado e a mesma requisição
 * pode ser reenviada com a mesma idempotency key. -> 503
 */
export class TransientFailureError extends ApplicationError {
  readonly code = 'TRANSIENT_FAILURE';

  constructor(
    public readonly reason: TransientReason,
    options?: ErrorOptions,
  ) {
    super(`Falha transitória (${reason}); a operação pode ser reenviada`, options);
  }
}
