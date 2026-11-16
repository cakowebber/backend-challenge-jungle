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
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

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
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  observedBalance: Money | undefined;
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

  scheduleReferenceRetry(now: Date, policy: BackoffPolicy): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this.id, this._status, 'scheduleReferenceRetry');
    }

    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt(now, this._referenceAttempts + 1, policy);
  }

  reject(code: BusinessFailureCode, observedBalance: Money): void {
    this.assertNotTerminal('reject');

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: InfrastructureFailureCode): void {
    this.assertNotTerminal('fail');

    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  declaresReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  hasExhaustedReferenceAttempts(maxAttempts: number): boolean {
    return this._referenceAttempts >= maxAttempts;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

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

  private static validateMoney(kind: WagerTransactionKind, money: Money): void {
    if (money.isNegative()) {
      throw new DomainValidationError('money', 'não pode ser negativo');
    }
    if (kind !== WagerTransactionKind.Loss && money.isZero()) {
      throw new DomainValidationError('money', `${kind} exige valor maior que zero`);
    }
  }

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
