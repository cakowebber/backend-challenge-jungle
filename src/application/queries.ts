import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { InvalidRequestError, ResourceNotFoundError } from './errors';
import type { LedgerRepository, WagerTransactionRepository, WalletRepository } from './ports/repositories';
import type { UnitOfWork } from './ports/unit-of-work';

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;

export interface LedgerPage {
  items: WalletLedgerEntry[];
  nextCursor: string | undefined;
}

function encodeCursor(position: string): string {
  return Buffer.from(JSON.stringify({ p: position }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const position = (decoded as { p?: unknown }).p;
    if (typeof position === 'string' && /^\d{1,19}$/.test(position)) {
      return position;
    }
  } catch {
  }
  throw new InvalidRequestError([{ field: 'cursor', message: 'cursor inválido' }]);
}

export class WalletQueries {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.unitOfWork.session(() => this.wallets.findById(walletId));
    if (wallet === undefined) {
      throw new ResourceNotFoundError('Wallet', walletId);
    }
    return wallet;
  }

  async getLedgerPage(walletId: string, options: { cursor: string | undefined; limit: number }): Promise<LedgerPage> {
    const afterPosition = options.cursor === undefined ? undefined : decodeCursor(options.cursor);

    return this.unitOfWork.session(async () => {
      if ((await this.wallets.findById(walletId)) === undefined) {
        throw new ResourceNotFoundError('Wallet', walletId);
      }

      const rows = await this.ledger.listByWallet(walletId, { afterPosition, limit: options.limit + 1 });
      const page = rows.slice(0, options.limit);
      const last = page.at(-1);

      return {
        items: page.map((row) => row.entry),
        nextCursor: rows.length > options.limit && last !== undefined ? encodeCursor(last.position) : undefined,
      };
    });
  }
}

export class TransactionQueries {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly transactions: WagerTransactionRepository,
  ) {}

  async getById(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.unitOfWork.session(() => this.transactions.findById(transactionId));
    if (transaction === undefined) {
      throw new ResourceNotFoundError('Transação', transactionId);
    }
    return transaction;
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.unitOfWork.session(() =>
      this.transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (transaction === undefined) {
      throw new ResourceNotFoundError('Transação', `${providerId}/${externalTransactionId}`);
    }
    return transaction;
  }
}
