import {
  CurrencyMismatchError,
  DomainValidationError,
  InsufficientFundsError,
  requireNonEmpty,
} from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  /** A moeda da wallet é a moeda do saldo. */
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Ids da transação OPENING e do seu lançamento. Só são usados se o saldo inicial for positivo. */
  openingTransactionId: string;
  openingEntryId: string;
}

export interface WalletOpening {
  wallet: Wallet;
  /** Lançamento CREDIT do saldo inicial; undefined quando a wallet abre zerada. */
  openingEntry: WalletLedgerEntry | undefined;
}

/** Uma movimentação de saldo, sempre ligada à transação que a causou. */
export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root. O saldo só muda por `debit`/`credit`, e cada um devolve o
 * lançamento de ledger correspondente: não existe forma de mover saldo sem
 * produzir o lançamento, nem de produzir o lançamento sem mover o saldo.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial e version 1. O crédito de abertura faz
   * parte da criação, por isso não incrementa a versão — mas gera lançamento,
   * para o ledger explicar todo o saldo desde o primeiro centavo.
   */
  static open(props: OpenWalletProps): WalletOpening {
    requireNonEmpty('id', props.id);
    requireNonEmpty('playerId', props.playerId);
    if (props.initialBalance.isNegative()) {
      throw new DomainValidationError('initialBalance', 'não pode ser negativo');
    }

    const { initialBalance, at } = props;
    const wallet = new Wallet(props.id, props.playerId, initialBalance.currency, initialBalance, 1, at, at);

    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: wallet.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.balance.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Há saldo para debitar este valor? As regras consultam antes de decidir rejeitar. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Lança InsufficientFundsError se o saldo ficaria negativo — o estado não muda. */
  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovable(movement.money);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, movement, this._balance.subtract(movement.money));
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovable(movement.money);
    return this.apply(LedgerDirection.Credit, movement, this._balance.add(movement.money));
  }

  /**
   * Único ponto que altera saldo. O lançamento é criado ANTES de mutar o estado:
   * se ele for inválido, a wallet permanece intacta.
   */
  private apply(direction: LedgerDirection, movement: WalletMovement, balanceAfter: Money): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: movement.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new DomainValidationError('money', 'movimentação deve ter valor positivo');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
