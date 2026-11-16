import type { ReferenceRetryPolicy } from '../../src/domain/backoff';
import { Money } from '../../src/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
  type WagerTransactionState,
} from '../../src/domain/wager-transaction';
import { Wallet, type WalletState } from '../../src/domain/wallet';

export const NOW = new Date('2026-07-29T15:00:00.000Z');
export const WALLET_ID = 'wallet-1';
export const PLAYER_ID = 'player-1';
export const PROVIDER_ID = 'provider-a';
export const ROUND_ID = 'round-987';

export const RETRY_POLICY: ReferenceRetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 3 };

let sequence = 0;
export function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

export function usd(amount: string): Money {
  return Money.from({ amount, currency: 'USD' });
}

export function walletWith(balance: Money, overrides: Partial<WalletState> = {}): Wallet {
  return Wallet.rehydrate({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    balance,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

export function submitted(
  kind: WagerTransactionKind,
  money: Money,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  return WagerTransaction.create({
    id: nextId('tx'),
    providerId: PROVIDER_ID,
    externalTransactionId,
    idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
    payloadHash: `hash-of-${externalTransactionId}`,
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: ROUND_ID,
    gameId: 'fortune-chimp',
    kind,
    money,
    createdAt: NOW,
    ...overrides,
  });
}

export function persisted(overrides: Partial<WagerTransactionState> = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  return WagerTransaction.rehydrate({
    id: nextId('tx'),
    providerId: PROVIDER_ID,
    externalTransactionId,
    idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
    payloadHash: `hash-of-${externalTransactionId}`,
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: ROUND_ID,
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    createdAt: NOW,
    status: WagerTransactionStatus.Processed,
    referenceTransactionId: undefined,
    failureCode: undefined,
    processedAt: NOW,
    observedBalance: undefined,
    referenceAttempts: 0,
    nextReferenceAttemptAt: undefined,
    ...overrides,
  });
}
