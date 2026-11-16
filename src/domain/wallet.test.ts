import { describe, expect, test } from 'bun:test';
import { brl, NOW, usd, walletWith } from '../../test/support/domain-fixtures';
import { CurrencyMismatchError, DomainValidationError, InsufficientFundsError } from './errors';
import { Money } from './money';
import { Wallet } from './wallet';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

const LATER = new Date('2026-07-29T15:05:00.000Z');

function open(initialBalance: Money) {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance,
    at: NOW,
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
  });
}

function movement(money: Money, n = 1) {
  return { entryId: `entry-${n}`, transactionId: `tx-${n}`, money, at: LATER };
}

/** Saldo reconstruído pelo ledger: soma dos créditos menos os débitos. */
function balanceFromLedger(entries: readonly WalletLedgerEntry[], currency: string): Money {
  return entries.reduce((total, entry) => total.add(entry.signedAmount()), Money.zero(currency));
}

describe('Wallet.open', () => {
  test('com saldo inicial: version 1 e um lançamento CREDIT de 0.00 até o saldo', () => {
    const { wallet, openingEntry } = open(brl('1000.00'));

    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt).toBe(NOW);
    expect(openingEntry).toMatchObject({
      id: 'entry-opening',
      walletId: 'wallet-1',
      transactionId: 'tx-opening',
      direction: LedgerDirection.Credit,
    });
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe('1000.00');
  });

  test('zerada: version 1 e nenhum lançamento', () => {
    const { wallet, openingEntry } = open(Money.zero('BRL'));

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('rejeita saldo inicial negativo', () => {
    expect(() => open(brl('1.00').negate())).toThrow(DomainValidationError);
  });

  test('rejeita id ou playerId vazios', () => {
    const base = {
      initialBalance: brl('1.00'),
      at: NOW,
      openingTransactionId: 'tx',
      openingEntryId: 'entry',
    };

    expect(() => Wallet.open({ ...base, id: '', playerId: 'p' })).toThrow(DomainValidationError);
    expect(() => Wallet.open({ ...base, id: 'w', playerId: ' ' })).toThrow(DomainValidationError);
  });
});

describe('Wallet.debit / credit', () => {
  test('débito reduz o saldo, incrementa a versão e devolve o lançamento correspondente', () => {
    const wallet = walletWith(brl('100.00'));

    const entry = wallet.debit(movement(brl('80.00')));

    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toBe(LATER);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe(wallet.id);
    expect(entry.transactionId).toBe('tx-1');
    expect(entry.money.toJSON().amount).toBe('80.00');
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
  });

  test('crédito aumenta o saldo, incrementa a versão e devolve o lançamento correspondente', () => {
    const wallet = walletWith(brl('20.00'));

    const entry = wallet.credit(movement(brl('50.00')));

    expect(wallet.balance.toJSON().amount).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toJSON().amount).toBe('20.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('70.00');
  });

  test('pode debitar exatamente o saldo, chegando a zero', () => {
    const wallet = walletWith(brl('80.00'));

    wallet.debit(movement(brl('80.00')));

    expect(wallet.balance.isZero()).toBe(true);
  });

  test('saldo nunca fica negativo: débito acima do saldo lança e não altera nada', () => {
    const wallet = walletWith(brl('20.00'));

    expect(() => wallet.debit(movement(brl('20.01')))).toThrow(InsufficientFundsError);

    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toBe(NOW);
  });

  test('canDebit responde sem alterar o estado', () => {
    const wallet = walletWith(brl('100.00'));

    expect(wallet.canDebit(brl('100.00'))).toBe(true);
    expect(wallet.canDebit(brl('100.01'))).toBe(false);
    expect(wallet.version).toBe(1);
  });

  test('a moeda da operação deve ser a da wallet', () => {
    const wallet = walletWith(brl('100.00'));

    expect(() => wallet.debit(movement(usd('10.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(movement(usd('10.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd('10.00'))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('movimentação zero ou negativa é rejeitada — a versão só muda quando o saldo muda', () => {
    const wallet = walletWith(brl('100.00'));

    expect(() => wallet.credit(movement(Money.zero('BRL')))).toThrow(DomainValidationError);
    expect(() => wallet.debit(movement(Money.zero('BRL')))).toThrow(DomainValidationError);
    expect(() => wallet.credit(movement(brl('5.00').negate()))).toThrow(DomainValidationError);
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet — saldo e ledger andam juntos', () => {
  test('após uma sequência de operações, o saldo é igual ao reconstruído pelo ledger', () => {
    const { wallet, openingEntry } = open(brl('100.00'));
    const ledger: WalletLedgerEntry[] = [openingEntry as WalletLedgerEntry];

    ledger.push(wallet.debit(movement(brl('80.00'), 1)));
    ledger.push(wallet.credit(movement(brl('150.25'), 2)));
    ledger.push(wallet.debit(movement(brl('0.01'), 3)));
    expect(() => wallet.debit(movement(brl('9999.00'), 4))).toThrow(InsufficientFundsError);
    ledger.push(wallet.credit(movement(brl('80.00'), 5)));

    expect(wallet.balance.toJSON().amount).toBe('250.24');
    expect(balanceFromLedger(ledger, 'BRL').equals(wallet.balance)).toBe(true);
    // version 1 na abertura + uma por movimentação aplicada (a rejeitada não conta)
    expect(wallet.version).toBe(5);
    expect(ledger).toHaveLength(5);
  });

  test('cada lançamento começa onde o anterior terminou', () => {
    const wallet = walletWith(brl('100.00'));

    const primeiro = wallet.debit(movement(brl('30.00'), 1));
    const segundo = wallet.credit(movement(brl('5.00'), 2));

    expect(segundo.balanceBefore.equals(primeiro.balanceAfter)).toBe(true);
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói o estado persistido sem revalidar nem gerar lançamento', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      balance: brl('975.00'),
      version: 42,
      createdAt: NOW,
      updatedAt: LATER,
    });

    expect(wallet.id).toBe('wallet-9');
    expect(wallet.playerId).toBe('player-9');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON().amount).toBe('975.00');
    expect(wallet.version).toBe(42);
    expect(wallet.updatedAt).toBe(LATER);
  });
});
