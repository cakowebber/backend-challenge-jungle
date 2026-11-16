import type { ReferenceRetryPolicy } from './backoff';
import { DomainInvariantError } from './errors';
import { BusinessFailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';
import type { Wallet } from './wallet';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

export interface ApplyWagerRulesInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  reference: WagerTransaction | undefined;
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  now: Date;
  referenceRetryPolicy: ReferenceRetryPolicy;
}

export interface WagerRulesResult {
  ledgerEntry: WalletLedgerEntry | undefined;
}

const ALLOWED_REFERENCE_KINDS: Record<WagerTransactionKind, readonly WagerTransactionKind[]> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export function applyWagerRules(input: ApplyWagerRulesInput): WagerRulesResult {
  const { wallet, transaction, reference, now } = input;

  assertApplicable(wallet, transaction);

  if (transaction.playerId !== wallet.playerId) {
    return rejected(input, BusinessFailureCode.PlayerWalletMismatch);
  }
  if (transaction.money.currency !== wallet.currency) {
    return rejected(input, BusinessFailureCode.CurrencyMismatch);
  }

  if (transaction.declaresReference()) {
    if (reference === undefined) {
      return awaitReference(input);
    }
    const failure = referenceFailure(input, reference);
    if (failure !== undefined) {
      return rejected(input, failure);
    }
    if (!reference.isTerminal()) {
      return awaitReference(input);
    }
  }

  if (!transaction.affectsBalance()) {
    transaction.markProcessed(reference?.id, wallet.balance, now);
    return { ledgerEntry: undefined };
  }

  const movement = {
    entryId: input.ledgerEntryId,
    transactionId: transaction.id,
    money: transaction.money,
    at: now,
  };

  if (transaction.ledgerDirectionFor(reference) === LedgerDirection.Credit) {
    const ledgerEntry = wallet.credit(movement);
    transaction.markProcessed(reference?.id, wallet.balance, now);
    return { ledgerEntry };
  }

  if (!wallet.canDebit(transaction.money)) {
    return rejected(
      input,
      transaction.kind === WagerTransactionKind.Bet
        ? BusinessFailureCode.InsufficientFunds
        : BusinessFailureCode.ReversalWouldOverdraw,
    );
  }
  const ledgerEntry = wallet.debit(movement);
  transaction.markProcessed(reference?.id, wallet.balance, now);
  return { ledgerEntry };
}

function assertApplicable(wallet: Wallet, transaction: WagerTransaction): void {
  if (transaction.walletId !== wallet.id) {
    throw new DomainInvariantError(
      `transação ${transaction.id} é da wallet ${transaction.walletId}, não da ${wallet.id}`,
    );
  }
  if (transaction.kind === WagerTransactionKind.Opening) {
    throw new DomainInvariantError('OPENING é aplicada na abertura da wallet, não pelas regras de aposta');
  }
}

function referenceFailure(
  { transaction, referenceAlreadyReversed }: ApplyWagerRulesInput,
  reference: WagerTransaction,
): BusinessFailureCode | undefined {
  const sameContext =
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.roundId === transaction.roundId &&
    reference.money.currency === transaction.money.currency;
  if (!sameContext) {
    return BusinessFailureCode.ReferenceContextMismatch;
  }

  if (!ALLOWED_REFERENCE_KINDS[transaction.kind].includes(reference.kind)) {
    return BusinessFailureCode.ReferenceKindNotAllowed;
  }

  if (reference.isTerminal() && reference.status !== WagerTransactionStatus.Processed) {
    return BusinessFailureCode.ReferenceNotProcessed;
  }

  if (!transaction.requiresReference()) {
    return undefined;
  }
  if (!transaction.money.equals(reference.money)) {
    return BusinessFailureCode.ReferenceAmountMismatch;
  }
  if (referenceAlreadyReversed) {
    return BusinessFailureCode.ReferenceAlreadyReversed;
  }
  return undefined;
}

function awaitReference(input: ApplyWagerRulesInput): WagerRulesResult {
  const { wallet, transaction, now, referenceRetryPolicy } = input;

  if (transaction.status === WagerTransactionStatus.Pending) {
    transaction.markPendingReference(wallet.balance, now, referenceRetryPolicy);
    return { ledgerEntry: undefined };
  }

  transaction.scheduleReferenceRetry(now, referenceRetryPolicy);
  if (transaction.hasExhaustedReferenceAttempts(referenceRetryPolicy.maxAttempts)) {
    transaction.reject(BusinessFailureCode.ReferenceNotFound, wallet.balance);
  }
  return { ledgerEntry: undefined };
}

function rejected({ wallet, transaction }: ApplyWagerRulesInput, code: BusinessFailureCode): WagerRulesResult {
  transaction.reject(code, wallet.balance);
  return { ledgerEntry: undefined };
}
