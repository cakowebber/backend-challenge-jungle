import type { ProcessWagerTransactionResult } from '../../application/process-wager-transaction';
import type { LedgerPage } from '../../application/queries';
import type { ReconciliationReport } from '../../application/reconcile-wallet';
import type { MoneyProps } from '../../domain/money';
import { WagerTransactionStatus, type WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

/** Domínio -> JSON da API. Dinheiro sai sempre como { amount: "25.00", currency }. */

export function presentWallet(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export interface SubmissionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo observado quando a transação foi resolvida — o mesmo em qualquer replay. */
  balance: MoneyProps | null;
  failureCode?: string;
  idempotentReplay: boolean;
}

/**
 * Resposta de POST /wagering/transactions. É montada só a partir do que está
 * gravado na transação, então um replay devolve exatamente o mesmo corpo
 * (com idempotentReplay: true).
 */
export function presentSubmission(result: ProcessWagerTransactionResult): SubmissionResponse {
  const { transaction } = result;
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.observedBalance?.toJSON() ?? null,
    ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
    idempotentReplay: result.idempotentReplay,
  };
}

/**
 * Status HTTP derivado do estado gravado — por isso o replay repete o status:
 *   PROCESSED -> 201 · PENDING_REFERENCE -> 202 · REJECTED -> 422 · FAILED -> 500
 */
export function statusCodeFor(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

export function presentTransaction(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    balance: transaction.observedBalance?.toJSON() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}

function presentLedgerEntry(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function presentLedgerPage(page: LedgerPage) {
  return {
    items: page.items.map(presentLedgerEntry),
    nextCursor: page.nextCursor ?? null,
  };
}

export function presentReconciliation(report: ReconciliationReport) {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
  };
}
