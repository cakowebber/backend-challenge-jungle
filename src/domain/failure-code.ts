/**
 * Taxonomia de falhas. Cada código é estável e legível por máquina: o provedor
 * decide o que fazer só por ele, sem interpretar mensagem.
 *
 * Toda transação com failureCode é terminal. Reenviar o mesmo id devolve a mesma
 * resposta (replay); "corrigir" significa enviar um novo externalTransactionId.
 */

/** Rejeições por regra de negócio -> status REJECTED. */
export enum BusinessFailureCode {
  /** BET maior que o saldo. Provedor: desistir. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK de WIN ou REFUND deixaria o saldo negativo. Provedor: escalar para operação. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Moeda da operação diferente da moeda da wallet. Provedor: corrigir. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** A wallet não pertence ao playerId informado. Provedor: corrigir. */
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** A referência não chegou dentro do limite de tentativas. Provedor: enviar a referência e uma nova reversão. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** A referência é de outro player, wallet ou rodada. Provedor: corrigir. */
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  /** O kind da referência não pode ser referenciado por esta operação. Provedor: corrigir. */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** A referência terminou REJECTED ou FAILED: não há efeito a reverter. Provedor: desistir. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Valor da reversão diferente do valor da referência. Provedor: corrigir. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** A referência já tem uma reversão aplicada. Provedor: desistir. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
}

/** Erros permanentes de infraestrutura -> status FAILED. */
export enum InfrastructureFailureCode {
  /** Falha permanente ao processar. Provedor: não reenviar, contatar suporte. */
  ProcessingFailed = 'PROCESSING_FAILED',
}

export type FailureCode = BusinessFailureCode | InfrastructureFailureCode;
