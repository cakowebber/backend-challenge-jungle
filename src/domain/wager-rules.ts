import type { ReferenceRetryPolicy } from './backoff';
import { DomainInvariantError } from './errors';
import { BusinessFailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';
import type { Wallet } from './wallet';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

export interface ApplyWagerRulesInput {
  /** Wallet da transação, já travada pelo chamador (SELECT ... FOR UPDATE). */
  wallet: Wallet;
  /** Em PENDING (primeira avaliação) ou PENDING_REFERENCE (nova tentativa do worker). */
  transaction: WagerTransaction;
  /** Resultado da busca por (providerId, referenceExternalTransactionId); undefined se ainda não chegou. */
  reference: WagerTransaction | undefined;
  /** Já existe uma reversão (REFUND ou ROLLBACK) PROCESSED apontando para a referência? */
  referenceAlreadyReversed: boolean;
  /** Id do lançamento de ledger, usado apenas se houver movimentação. */
  ledgerEntryId: string;
  now: Date;
  referenceRetryPolicy: ReferenceRetryPolicy;
}

export interface WagerRulesResult {
  /** Presente somente quando o saldo mudou. O desfecho está em `transaction.status`. */
  ledgerEntry: WalletLedgerEntry | undefined;
}

/** Quais kinds cada operação pode referenciar (desafio 7, regra 3 + interpretação para WIN/LOSS). */
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

/**
 * Todas as regras de negócio de uma transação, em um único lugar e sem IO.
 * Leva a transação a PROCESSED, REJECTED ou PENDING_REFERENCE e, se houver
 * efeito financeiro, move o saldo da wallet devolvendo o lançamento.
 *
 * A ordem das checagens define qual failureCode vence quando há mais de um
 * problema, por isso é fixa:
 *   1. wallet x player          4. referência: contexto, kind, status, valor, reversão única
 *   2. moeda                    5. saldo
 *   3. referência ausente
 */
export function applyWagerRules(input: ApplyWagerRulesInput): WagerRulesResult {
  const { wallet, transaction, reference, now } = input;

  assertApplicable(wallet, transaction);

  // 1 e 2: a operação é mesmo desta wallet?
  if (transaction.playerId !== wallet.playerId) {
    return rejected(input, BusinessFailureCode.PlayerWalletMismatch);
  }
  if (transaction.money.currency !== wallet.currency) {
    return rejected(input, BusinessFailureCode.CurrencyMismatch);
  }

  // 3 e 4: referência
  if (transaction.declaresReference()) {
    if (reference === undefined) {
      return awaitReference(input);
    }
    const failure = referenceFailure(input, reference);
    if (failure !== undefined) {
      return rejected(input, failure);
    }
    // A referência existe e é válida, mas ela mesma ainda aguarda a própria referência.
    if (!reference.isTerminal()) {
      return awaitReference(input);
    }
  }

  // 5: efeito no saldo
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
    // Aposta sem saldo e reversão que negativaria são situações operacionais
    // diferentes e precisam de códigos diferentes (desafio 7, regra 9).
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

/** Erros de quem chamou, não do provedor: nunca viram rejeição de negócio. */
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

/** Valida uma referência que existe. Devolve o primeiro problema encontrado, ou undefined. */
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

  // Terminal sem ter sido aplicada: não existe efeito para reverter.
  if (reference.isTerminal() && reference.status !== WagerTransactionStatus.Processed) {
    return BusinessFailureCode.ReferenceNotProcessed;
  }

  // As duas últimas regras valem só para reversões (REFUND/ROLLBACK).
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

/**
 * A referência ainda não pode ser usada. Primeira vez: PENDING_REFERENCE.
 * Nas tentativas seguintes do worker: conta a tentativa e, esgotado o limite,
 * rejeita com REFERENCE_NOT_FOUND.
 */
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
