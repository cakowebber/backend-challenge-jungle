import { requireNonEmpty, UnbalancedLedgerEntryError } from './errors';
import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Lançamento do ledger. Imutável por estrutura: todos os campos são readonly,
 * a instância é congelada e não existe método de transição.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Valida a aritmética: um lançamento que não fecha nunca chega a existir. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    requireNonEmpty('id', props.id);
    requireNonEmpty('walletId', props.walletId);
    requireNonEmpty('transactionId', props.transactionId);

    const entry = WalletLedgerEntry.rehydrate(props);

    if (!entry.money.isPositive()) {
      throw new UnbalancedLedgerEntryError('o valor do lançamento deve ser positivo');
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new UnbalancedLedgerEntryError('saldo antes/depois não pode ser negativo');
    }
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `${entry.balanceBefore} ${entry.direction} ${entry.money} não resulta em ${entry.balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir da persistência — não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito do lançamento no saldo: positivo para crédito, negativo para débito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
