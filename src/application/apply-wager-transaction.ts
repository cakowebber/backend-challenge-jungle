import type { ReferenceRetryPolicy } from '../domain/backoff';
import type { EventContext, IntegrationEvent } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wager-events';
import { OutboxMessage } from '../domain/outbox-message';
import { applyWagerRules } from '../domain/wager-rules';
import { WagerTransactionStatus, type WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { IdGenerator } from './ports/id-generator';
import type {
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from './ports/repositories';

export const REFERENCE_RETRY_POLICY = Symbol('REFERENCE_RETRY_POLICY');

export interface ApplyContext {
  correlationId: string;
  causationId: string | undefined;
  now: Date;
}

export class ApplyWagerTransaction {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly ids: IdGenerator,
    private readonly referenceRetryPolicy: ReferenceRetryPolicy,
  ) {}

  async apply(wallet: Wallet, transaction: WagerTransaction, context: ApplyContext): Promise<void> {
    const versionUnderLock = wallet.version;
    const statusBefore = transaction.status;

    let reference: WagerTransaction | undefined;
    let referenceAlreadyReversed = false;
    if (transaction.referenceExternalTransactionId !== undefined) {
      reference = await this.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      if (reference !== undefined && transaction.requiresReference()) {
        referenceAlreadyReversed = await this.transactions.hasProcessedReversal(reference.id);
      }
    }

    const { ledgerEntry } = applyWagerRules({
      wallet,
      transaction,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      now: context.now,
      referenceRetryPolicy: this.referenceRetryPolicy,
    });

    if (ledgerEntry !== undefined) {
      await this.wallets.saveBalance(wallet, versionUnderLock);
      await this.ledger.append(ledgerEntry);
    }
    await this.transactions.saveOutcome(transaction);

    const events = this.eventsFor(wallet, transaction, ledgerEntry, statusBefore, context);
    await this.outbox.add(events.map((event) => OutboxMessage.enqueue(event)));
  }

  private eventsFor(
    wallet: Wallet,
    transaction: WagerTransaction,
    ledgerEntry: WalletLedgerEntry | undefined,
    statusBefore: WagerTransactionStatus,
    context: ApplyContext,
  ): IntegrationEvent<unknown>[] {
    const eventContext = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.now,
    });

    switch (transaction.status) {
      case WagerTransactionStatus.Processed: {
        const events: IntegrationEvent<unknown>[] = [WagerTransactionProcessed.from(transaction, eventContext())];
        if (ledgerEntry !== undefined) {
          events.push(WalletBalanceChanged.from(wallet, ledgerEntry, eventContext()));
        }
        return events;
      }
      case WagerTransactionStatus.Rejected:
        return [WagerTransactionRejected.from(transaction, eventContext())];
      case WagerTransactionStatus.PendingReference:
        return statusBefore === WagerTransactionStatus.PendingReference
          ? []
          : [WagerTransactionPendingReference.from(transaction, eventContext())];
      default:
        return [];
    }
  }
}
