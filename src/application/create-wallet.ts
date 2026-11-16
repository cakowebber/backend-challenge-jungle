import { DomainInvariantError } from '../domain/errors';
import type { EventContext } from '../domain/events/integration-event';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events/wager-events';
import type { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { WalletAlreadyExistsError } from './errors';
import { canonicalJson, sha256Hex } from './payload-hash';
import type { Clock } from './ports/clock';
import type { IdGenerator } from './ports/id-generator';
import type {
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from './ports/repositories';
import type { UnitOfWork } from './ports/unit-of-work';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

export class CreateWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const now = this.clock.now();
    const openingTransactionId = this.ids.next();

    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      at: now,
      openingTransactionId,
      openingEntryId: this.ids.next(),
    });

    return this.unitOfWork.transactional(async () => {
      const inserted = await this.wallets.insertIfAbsent(wallet);
      if (!inserted) {
        throw new WalletAlreadyExistsError(command.playerId, wallet.currency);
      }
      if (openingEntry === undefined) {
        return wallet;
      }

      const opening = WagerTransaction.opening({
        id: openingTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: command.initialBalance,
        payloadHash: sha256Hex(
          canonicalJson({ playerId: command.playerId, initialBalance: { ...command.initialBalance.toJSON() } }),
        ),
        createdAt: now,
      });
      opening.markProcessed(undefined, wallet.balance, now);

      if (!(await this.transactions.insertIfAbsent(opening))) {
        throw new DomainInvariantError(`a wallet ${wallet.id} é nova e já teria uma transação OPENING`);
      }
      await this.ledger.append(openingEntry);

      const eventContext = (): EventContext => ({
        eventId: this.ids.next(),
        correlationId: command.correlationId,
        occurredAt: now,
      });
      await this.outbox.add([
        OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, eventContext())),
        OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, eventContext())),
      ]);
      return wallet;
    });
  }
}
