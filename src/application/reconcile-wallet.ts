import type { Money } from '../domain/money';
import { ResourceNotFoundError } from './errors';
import { MetricName, type AppLogger, type Metrics } from './ports/observability';
import type { WalletRepository } from './ports/repositories';
import type { UnitOfWork } from './ports/unit-of-work';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.unitOfWork.session(() => this.wallets.ledgerSnapshot(walletId));
    if (snapshot === undefined) {
      throw new ResourceNotFoundError('Wallet', walletId);
    }

    const calculatedBalance = snapshot.credits.subtract(snapshot.debits);
    const difference = snapshot.storedBalance.subtract(calculatedBalance);
    const consistent = difference.isZero();

    if (!consistent) {
      this.metrics.increment(MetricName.ReconciliationDivergences);
      this.logger.error('reconciliação: saldo diverge do ledger', {
        walletId,
        difference: difference.toString(),
        checkedEntries: snapshot.entries,
      });
    }

    return {
      walletId,
      storedBalance: snapshot.storedBalance,
      calculatedBalance,
      difference,
      consistent,
      checkedEntries: snapshot.entries,
    };
  }
}
