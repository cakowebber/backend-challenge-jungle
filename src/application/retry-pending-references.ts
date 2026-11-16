import { WagerTransactionStatus } from '../domain/wager-transaction';
import type { ApplyWagerTransaction } from './apply-wager-transaction';
import { TransientFailureError } from './errors';
import type { Clock } from './ports/clock';
import type { IdGenerator } from './ports/id-generator';
import { MetricName, type AppLogger, type Metrics } from './ports/observability';
import type { PendingReferenceCandidate, WagerTransactionRepository, WalletRepository } from './ports/repositories';
import type { UnitOfWork } from './ports/unit-of-work';

export type ReferenceRetryOutcome =
  | 'RESOLVED'
  | 'REJECTED'
  | 'RESCHEDULED'
  | 'SKIPPED'
  | 'ERRORED';

export interface RetryPendingReferencesResult {
  found: number;
  outcomes: Readonly<Record<ReferenceRetryOutcome, number>>;
}

export class RetryPendingReferences {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly applier: ApplyWagerTransaction,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(limit: number): Promise<RetryPendingReferencesResult> {
    const candidates = await this.unitOfWork.session(() =>
      this.transactions.findDuePendingReferences(this.clock.now(), limit),
    );

    const outcomes: Record<ReferenceRetryOutcome, number> = {
      RESOLVED: 0,
      REJECTED: 0,
      RESCHEDULED: 0,
      SKIPPED: 0,
      ERRORED: 0,
    };
    for (const candidate of candidates) {
      const outcome = await this.retryGuarded(candidate);
      outcomes[outcome] += 1;
      this.metrics.increment(MetricName.ReferenceRetries, { outcome });
      if (outcome === 'RESOLVED') {
        this.metrics.increment(MetricName.TransactionsByStatus, { status: WagerTransactionStatus.Processed });
      } else if (outcome === 'REJECTED') {
        this.metrics.increment(MetricName.TransactionsByStatus, { status: WagerTransactionStatus.Rejected });
      }
    }
    return { found: candidates.length, outcomes };
  }

  private async retryGuarded(candidate: PendingReferenceCandidate): Promise<ReferenceRetryOutcome> {
    try {
      return await this.retry(candidate);
    } catch (error) {
      const fields = {
        transactionId: candidate.transactionId,
        walletId: candidate.walletId,
        reason: error instanceof Error ? error.message : String(error),
      };
      if (error instanceof TransientFailureError) {
        this.logger.warn('pending-reference: tentativa adiada por falha transitória', fields);
      } else {
        this.logger.error('pending-reference: erro inesperado ao reprocessar', fields);
      }
      return 'ERRORED';
    }
  }

  private retry(candidate: PendingReferenceCandidate): Promise<ReferenceRetryOutcome> {
    return this.unitOfWork.transactional(async (): Promise<ReferenceRetryOutcome> => {
      const wallet = await this.wallets.lockById(candidate.walletId);
      const transaction = await this.transactions.findById(candidate.transactionId);
      const now = this.clock.now();

      if (
        wallet === undefined ||
        transaction === undefined ||
        transaction.status !== WagerTransactionStatus.PendingReference ||
        transaction.nextReferenceAttemptAt === undefined ||
        transaction.nextReferenceAttemptAt > now
      ) {
        return 'SKIPPED';
      }

      await this.applier.apply(wallet, transaction, {
        correlationId: this.ids.next(),
        causationId: transaction.id,
        now,
      });

      const statusAfter = transaction.status as WagerTransactionStatus;
      switch (statusAfter) {
        case WagerTransactionStatus.Processed:
          return 'RESOLVED';
        case WagerTransactionStatus.Rejected:
          return 'REJECTED';
        default:
          return 'RESCHEDULED';
      }
    });
  }
}
