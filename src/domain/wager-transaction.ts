import { nextAttemptAt, type BackoffPolicy } from './backoff';
import {
  DomainInvariantError,
  DomainValidationError,
  InvalidTransactionStateError,
  requireNonEmpty,
} from './errors';
import type { BusinessFailureCode, FailureCode, InfrastructureFailureCode } from './failure-code';
import type { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada (nunca é commitada)
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violação de regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal)
}

/** Identidade usada nas transações internas (OPENING). Nenhum provedor pode usá-la. */
export const INTERNAL_PROVIDER_ID = 'internal';

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id da referência NO PROVEDOR — não o id interno. */
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  /** Id interno da referência, preenchido quando ela é resolvida. */
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  /** Saldo da wallet no momento da resolução. É o que o replay devolve. */
  observedBalance: Money | undefined;
  /** Quantas vezes o worker já tentou resolver a referência. */
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  createdAt: Date;
}

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Transições válidas (qualquer outra lança InvalidTransactionStateError):
 *
 *   PENDING           -> PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
 *                        (scheduleReferenceRetry mantém o estado e conta a tentativa)
 *   PROCESSED, REJECTED, FAILED -> nenhuma (terminais)
 */
export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _observedBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._observedBalance = state.observedBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceAttemptAt = state.nextReferenceAttemptAt;
  }

  /**
   * Transação submetida por um provedor (HTTP ou fila). Nasce em PENDING.
   * Erros aqui são de payload (DomainValidationError), não rejeição de negócio.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    requireNonEmpty('id', props.id);
    requireNonEmpty('providerId', props.providerId);
    requireNonEmpty('externalTransactionId', props.externalTransactionId);
    requireNonEmpty('idempotencyKey', props.idempotencyKey);
    requireNonEmpty('payloadHash', props.payloadHash);
    requireNonEmpty('walletId', props.walletId);
    requireNonEmpty('playerId', props.playerId);
    requireNonEmpty('roundId', props.roundId);
    requireNonEmpty('gameId', props.gameId);

    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new DomainValidationError('kind', `"${String(props.kind)}" não é um tipo de operação conhecido`);
    }
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainValidationError('kind', 'OPENING é interno e não pode ser submetido');
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new DomainValidationError('providerId', `"${INTERNAL_PROVIDER_ID}" é reservado`);
    }

    WagerTransaction.validateMoney(props.kind, props.money);
    const reference = WagerTransaction.validateReference(props);

    return new WagerTransaction({
      ...props,
      referenceExternalTransactionId: reference,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      observedBalance: undefined,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
    });
  }

  /**
   * Transação interna do saldo inicial da wallet. As chaves são derivadas do
   * walletId, então as constraints de unicidade do banco também garantem no
   * máximo uma abertura por wallet.
   */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    requireNonEmpty('id', props.id);
    requireNonEmpty('walletId', props.walletId);
    requireNonEmpty('playerId', props.playerId);
    requireNonEmpty('payloadHash', props.payloadHash);
    if (!props.money.isPositive()) {
      throw new DomainValidationError('money', 'OPENING só existe para saldo inicial positivo');
    }

    return new WagerTransaction({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: INTERNAL_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      observedBalance: undefined,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
    });
  }

  /** Reconstrução a partir da persistência — não revalida nada. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições

  /** PENDING | PENDING_REFERENCE -> PROCESSED. */
  markProcessed(referenceTransactionId: string | undefined, observedBalance: Money, at: Date): void {
    this.assertNotTerminal('markProcessed');
    if (this.declaresReference() !== (referenceTransactionId !== undefined)) {
      throw new DomainInvariantError(
        this.declaresReference()
          ? `transação ${this.id} declara referência e foi processada sem ela resolvida`
          : `transação ${this.id} não declara referência e recebeu uma`,
      );
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._observedBalance = observedBalance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  /** PENDING -> PENDING_REFERENCE. Agenda a primeira tentativa do worker. */
  markPendingReference(observedBalance: Money, now: Date, policy: BackoffPolicy): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this.id, this._status, 'markPendingReference');
    }
    if (!this.declaresReference()) {
      throw new DomainInvariantError(`transação ${this.id} não declara referência para aguardar`);
    }

    this._status = WagerTransactionStatus.PendingReference;
    this._observedBalance = observedBalance;
    this._referenceAttempts = 0;
    this._nextReferenceAttemptAt = nextAttemptAt(now, 1, policy);
  }

  /** PENDING_REFERENCE -> PENDING_REFERENCE: conta a tentativa frustrada e agenda a próxima. */
  scheduleReferenceRetry(now: Date, policy: BackoffPolicy): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this.id, this._status, 'scheduleReferenceRetry');
    }

    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt(now, this._referenceAttempts + 1, policy);
  }

  /** PENDING | PENDING_REFERENCE -> REJECTED. Não altera saldo nem gera ledger. */
  reject(code: BusinessFailureCode, observedBalance: Money): void {
    this.assertNotTerminal('reject');

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  /** PENDING | PENDING_REFERENCE -> FAILED. */
  fail(code: InfrastructureFailureCode): void {
    this.assertNotTerminal('fail');

    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** false para LOSS: registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK: não existem sem a transação que revertem. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** O provedor informou uma referência (obrigatória ou opcional)? */
  declaresReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  hasExhaustedReferenceAttempts(maxAttempts: number): boolean {
    return this._referenceAttempts >= maxAttempts;
  }

  /** Mesma idempotency key só é replay se o payload for o mesmo; senão é conflito. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** ROLLBACK inverte a direção da transação que ele reverte; os demais têm direção fixa. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new DomainInvariantError('LOSS não movimenta saldo e não tem direção de ledger');
      case WagerTransactionKind.Rollback: {
        if (reference === undefined) {
          throw new DomainInvariantError('ROLLBACK precisa da referência para definir a direção');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  private assertNotTerminal(attempted: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, attempted);
    }
  }

  /** LOSS pode ser zero (só registra o resultado); os demais movem saldo e exigem valor positivo. */
  private static validateMoney(kind: WagerTransactionKind, money: Money): void {
    if (money.isNegative()) {
      throw new DomainValidationError('money', 'não pode ser negativo');
    }
    if (kind !== WagerTransactionKind.Loss && money.isZero()) {
      throw new DomainValidationError('money', `${kind} exige valor maior que zero`);
    }
  }

  /** REFUND/ROLLBACK exigem referência; WIN/LOSS aceitam; BET não pode ter. */
  private static validateReference(props: CreateWagerTransactionProps): string | undefined {
    const reference = props.referenceExternalTransactionId;
    const requires = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;

    if (reference === undefined) {
      if (requires) {
        throw new DomainValidationError('referenceExternalTransactionId', `é obrigatório para ${props.kind}`);
      }
      return undefined;
    }

    requireNonEmpty('referenceExternalTransactionId', reference);
    if (props.kind === WagerTransactionKind.Bet) {
      throw new DomainValidationError('referenceExternalTransactionId', 'BET não referencia outra transação');
    }
    if (reference === props.externalTransactionId) {
      throw new DomainValidationError('referenceExternalTransactionId', 'a transação não pode referenciar a si mesma');
    }
    return reference;
  }
}
