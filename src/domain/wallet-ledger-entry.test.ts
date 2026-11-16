import { describe, expect, test } from 'bun:test';
import { brl, NOW, usd } from '../../test/support/domain-fixtures';
import { CurrencyMismatchError, DomainValidationError, UnbalancedLedgerEntryError } from './errors';
import { LedgerDirection, WalletLedgerEntry, type CreateLedgerEntryProps } from './wallet-ledger-entry';

function props(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('80.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('20.00'),
    createdAt: NOW,
    ...overrides,
  };
}

describe('WalletLedgerEntry.create', () => {
  test('aceita débito que fecha: antes - valor = depois', () => {
    const entry = WalletLedgerEntry.create(props());

    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().toJSON().amount).toBe('-80.00');
  });

  test('aceita crédito que fecha: antes + valor = depois', () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceBefore: brl('20.00'), balanceAfter: brl('100.00') }),
    );

    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().toJSON().amount).toBe('80.00');
  });

  test('rejeita lançamento cuja aritmética não fecha', () => {
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: brl('20.01') }))).toThrow(
      UnbalancedLedgerEntryError,
    );
    expect(() => WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit }))).toThrow(
      UnbalancedLedgerEntryError,
    );
  });

  test('rejeita valor zero ou negativo', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ money: brl('0.00'), balanceAfter: brl('100.00') })),
    ).toThrow(UnbalancedLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create(props({ money: brl('80.00').negate(), balanceAfter: brl('180.00') })),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejeita saldo resultante negativo, mesmo com a aritmética fechando', () => {
    const negativo = brl('100.00').subtract(brl('150.00'));

    expect(() =>
      WalletLedgerEntry.create(props({ money: brl('150.00'), balanceAfter: negativo })),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejeita moedas misturadas', () => {
    expect(() => WalletLedgerEntry.create(props({ money: usd('80.00') }))).toThrow(CurrencyMismatchError);
  });

  test('rejeita identificadores vazios', () => {
    expect(() => WalletLedgerEntry.create(props({ id: '' }))).toThrow(DomainValidationError);
    expect(() => WalletLedgerEntry.create(props({ walletId: '' }))).toThrow(DomainValidationError);
    expect(() => WalletLedgerEntry.create(props({ transactionId: '' }))).toThrow(DomainValidationError);
  });
});

describe('WalletLedgerEntry — imutabilidade estrutural', () => {
  test('a instância é congelada: nenhum campo pode ser reescrito', () => {
    const entry = WalletLedgerEntry.create(props());

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: unknown }).balanceAfter = brl('999.00');
    }).toThrow(TypeError);
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('não revalida: reconstrói até um lançamento inconsistente, que isBalanced denuncia', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('999.00') }));

    expect(entry.isBalanced()).toBe(false);
  });
});
