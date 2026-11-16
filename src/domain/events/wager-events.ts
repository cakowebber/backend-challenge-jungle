import { DomainInvariantError } from '../errors';
import type { BusinessFailureCode, InfrastructureFailureCode } from '../failure-code';
import type { MoneyProps } from '../money';
import { WagerTransaction, WagerTransactionStatus, type WagerTransactionKind } from '../wager-transaction';
import type { Wallet } from '../wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet-ledger-entry';
import { IntegrationEvent, type EventContext } from './integration-event';

/** Identificação da transação, comum aos três eventos de transação. */
interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function identify(transaction: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

function assertStatus(transaction: WagerTransaction, expected: WagerTransactionStatus, eventType: string): void {
  if (transaction.status !== expected) {
    throw new DomainInvariantError(
      `${eventType} exige transação em ${expected}; ${transaction.id} está em ${transaction.status}`,
    );
  }
}

// ---- WagerTransactionProcessed: qualquer transação aplicada, inclusive LOSS

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId: string | null;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...identify(transaction),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        processedAt: (transaction.processedAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}

// ---- WagerTransactionRejected: rejeição por regra de negócio

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: BusinessFailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...identify(transaction),
        // REJECTED só é alcançado por reject(), que recebe um código de negócio.
        failureCode: transaction.failureCode as BusinessFailureCode,
      },
    });
  }
}

// ---- WagerTransactionFailed: erro permanente de infraestrutura (além dos eventos mínimos do desafio)

export interface WagerTransactionFailedData extends WagerTransactionEventData {
  failureCode: InfrastructureFailureCode;
}

export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    assertStatus(transaction, WagerTransactionStatus.Failed, 'WagerTransactionFailed');
    return new WagerTransactionFailed({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...identify(transaction),
        // FAILED só é alcançado por fail(), que recebe um código de infraestrutura.
        failureCode: transaction.failureCode as InfrastructureFailureCode,
      },
    });
  }
}

// ---- WagerTransactionPendingReference: referência ausente

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
  nextAttemptAt: string | null;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference, 'WagerTransactionPendingReference');
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...identify(transaction),
        // PENDING_REFERENCE só é alcançado por quem declara referência.
        referenceExternalTransactionId: transaction.referenceExternalTransactionId as string,
        nextAttemptAt: transaction.nextReferenceAttemptAt?.toISOString() ?? null,
      },
    });
  }
}

// ---- WalletBalanceChanged: somente quando o saldo muda

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  /** Só pode ser construído a partir de um lançamento: sem ledger, sem evento. */
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new DomainInvariantError(`lançamento ${entry.id} não pertence à wallet ${wallet.id}`);
    }
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
