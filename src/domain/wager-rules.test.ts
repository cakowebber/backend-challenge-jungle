import { describe, expect, test } from 'bun:test';
import {
  brl,
  nextId,
  NOW,
  persisted,
  RETRY_POLICY,
  submitted,
  usd,
  walletWith,
} from '../../test/support/domain-fixtures';
import { DomainInvariantError } from './errors';
import { BusinessFailureCode as Code } from './failure-code';
import { Money } from './money';
import { applyWagerRules, type ApplyWagerRulesInput } from './wager-rules';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from './wager-transaction';
import type { Wallet } from './wallet';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

function apply(
  wallet: Wallet,
  transaction: WagerTransaction,
  extra: Partial<Pick<ApplyWagerRulesInput, 'reference' | 'referenceAlreadyReversed' | 'now'>> = {},
) {
  return applyWagerRules({
    wallet,
    transaction,
    reference: undefined,
    referenceAlreadyReversed: false,
    ledgerEntryId: nextId('entry'),
    now: NOW,
    referenceRetryPolicy: RETRY_POLICY,
    ...extra,
  });
}

/** BET já aplicada, pronta para ser referenciada. */
function processedBet(amount = '25.00', externalTransactionId = 'bet-1') {
  return persisted({ kind: Kind.Bet, money: brl(amount), externalTransactionId });
}

/** REFUND ou ROLLBACK apontando para `bet-1` (ou outra referência). */
function reversal(kind: Kind.Refund | Kind.Rollback, amount = '25.00', referenceExternalTransactionId = 'bet-1') {
  return submitted(kind, brl(amount), { referenceExternalTransactionId });
}

/** Garante que uma rejeição não deixou rastro financeiro. */
function expectRejectedWithoutEffect(
  wallet: Wallet,
  tx: WagerTransaction,
  result: { ledgerEntry: unknown },
  code: Code,
  balance: string,
) {
  expect(tx.status).toBe(Status.Rejected);
  expect(tx.failureCode).toBe(code);
  expect(result.ledgerEntry).toBeUndefined();
  expect(wallet.balance.toJSON().amount).toBe(balance);
  expect(wallet.version).toBe(1);
  expect(tx.observedBalance?.toJSON().amount).toBe(balance);
}

describe('BET', () => {
  test('debita o saldo e gera um lançamento DEBIT', () => {
    const wallet = walletWith(brl('1000.00'));
    const bet = submitted(Kind.Bet, brl('25.00'));

    const { ledgerEntry } = apply(wallet, bet);

    expect(bet.status).toBe(Status.Processed);
    expect(wallet.balance.toJSON().amount).toBe('975.00');
    expect(wallet.version).toBe(2);
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(ledgerEntry?.transactionId).toBe(bet.id);
    expect(ledgerEntry?.balanceBefore.toJSON().amount).toBe('1000.00');
    expect(ledgerEntry?.balanceAfter.toJSON().amount).toBe('975.00');
    expect(bet.observedBalance?.toJSON().amount).toBe('975.00');
    expect(bet.processedAt).toBe(NOW);
  });

  test('pode consumir o saldo inteiro', () => {
    const wallet = walletWith(brl('25.00'));

    apply(wallet, submitted(Kind.Bet, brl('25.00')));

    expect(wallet.balance.isZero()).toBe(true);
  });

  test('saldo insuficiente: REJECTED com INSUFFICIENT_FUNDS, sem saldo nem ledger alterados', () => {
    const wallet = walletWith(brl('20.00'));
    const bet = submitted(Kind.Bet, brl('20.01'));

    const result = apply(wallet, bet);

    expectRejectedWithoutEffect(wallet, bet, result, Code.InsufficientFunds, '20.00');
  });

  test('cenário da seção 8 em sequência: 100.00, duas apostas de 80.00', () => {
    const wallet = walletWith(brl('100.00'));
    const primeira = submitted(Kind.Bet, brl('80.00'));
    const segunda = submitted(Kind.Bet, brl('80.00'));

    const lancamentos = [apply(wallet, primeira), apply(wallet, segunda)]
      .map((r) => r.ledgerEntry)
      .filter((entry) => entry !== undefined);

    expect(primeira.status).toBe(Status.Processed);
    expect(segunda.status).toBe(Status.Rejected);
    expect(segunda.failureCode).toBe(Code.InsufficientFunds);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(lancamentos).toHaveLength(1);
    expect(lancamentos[0]?.direction).toBe(LedgerDirection.Debit);
  });
});

describe('WIN', () => {
  test('sem referência: credita e gera um lançamento CREDIT', () => {
    const wallet = walletWith(brl('975.00'));
    const win = submitted(Kind.Win, brl('50.00'));

    const { ledgerEntry } = apply(wallet, win);

    expect(win.status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBeUndefined();
    expect(wallet.balance.toJSON().amount).toBe('1025.00');
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
  });

  test('referenciando a BET da rodada: credita e guarda o id interno da referência', () => {
    const wallet = walletWith(brl('975.00'));
    const bet = processedBet();
    const win = submitted(Kind.Win, brl('300.00'), { referenceExternalTransactionId: 'bet-1' });

    apply(wallet, win, { reference: bet });

    expect(win.status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    // WIN não precisa ter o mesmo valor da aposta
    expect(wallet.balance.toJSON().amount).toBe('1275.00');
  });

  test('referência declarada que não é uma BET é rejeitada', () => {
    const wallet = walletWith(brl('100.00'));
    const outroWin = persisted({ kind: Kind.Win, externalTransactionId: 'win-0' });
    const win = submitted(Kind.Win, brl('50.00'), { referenceExternalTransactionId: 'win-0' });

    const result = apply(wallet, win, { reference: outroWin });

    expectRejectedWithoutEffect(wallet, win, result, Code.ReferenceKindNotAllowed, '100.00');
  });

  test('referência declarada que ainda não chegou: aguarda, sem creditar', () => {
    const wallet = walletWith(brl('100.00'));
    const win = submitted(Kind.Win, brl('50.00'), { referenceExternalTransactionId: 'bet-1' });

    const { ledgerEntry } = apply(wallet, win);

    expect(win.status).toBe(Status.PendingReference);
    expect(ledgerEntry).toBeUndefined();
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });
});

describe('LOSS', () => {
  test('é PROCESSED sem mover saldo, sem lançamento e sem mudar a versão', () => {
    const wallet = walletWith(brl('975.00'));
    const loss = submitted(Kind.Loss, brl('25.00'));

    const { ledgerEntry } = apply(wallet, loss);

    expect(loss.status).toBe(Status.Processed);
    expect(ledgerEntry).toBeUndefined();
    expect(wallet.balance.toJSON().amount).toBe('975.00');
    expect(wallet.version).toBe(1);
    expect(loss.observedBalance?.toJSON().amount).toBe('975.00');
  });

  test('aceita valor zero e referência à BET', () => {
    const wallet = walletWith(brl('975.00'));
    const bet = processedBet();
    const loss = submitted(Kind.Loss, Money.zero('BRL'), { referenceExternalTransactionId: 'bet-1' });

    apply(wallet, loss, { reference: bet });

    expect(loss.status).toBe(Status.Processed);
    expect(loss.referenceTransactionId).toBe(bet.id);
  });
});

describe('REFUND', () => {
  test('credita o valor da BET referenciada', () => {
    const wallet = walletWith(brl('975.00'));
    const bet = processedBet();
    const refund = reversal(Kind.Refund);

    const { ledgerEntry } = apply(wallet, refund, { reference: bet });

    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toJSON().amount).toBe('1000.00');
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(ledgerEntry?.money.toJSON().amount).toBe('25.00');
  });

  test.each([Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback, Kind.Opening])(
    'só referencia BET: referência %s é rejeitada',
    (referenceKind) => {
      const wallet = walletWith(brl('100.00'));
      const reference = persisted({ kind: referenceKind, externalTransactionId: 'bet-1' });
      const refund = reversal(Kind.Refund);

      const result = apply(wallet, refund, { reference });

      expectRejectedWithoutEffect(wallet, refund, result, Code.ReferenceKindNotAllowed, '100.00');
    },
  );

  test('valor diferente do da referência é rejeitado (reversão parcial fora de escopo)', () => {
    const wallet = walletWith(brl('100.00'));
    const refund = reversal(Kind.Refund, '24.99');

    const result = apply(wallet, refund, { reference: processedBet('25.00') });

    expectRejectedWithoutEffect(wallet, refund, result, Code.ReferenceAmountMismatch, '100.00');
  });

  test('uma BET não é reembolsada duas vezes', () => {
    const wallet = walletWith(brl('100.00'));
    const refund = reversal(Kind.Refund);

    const result = apply(wallet, refund, { reference: processedBet(), referenceAlreadyReversed: true });

    expectRejectedWithoutEffect(wallet, refund, result, Code.ReferenceAlreadyReversed, '100.00');
  });

  test('BET que foi rejeitada não tem o que reembolsar', () => {
    const wallet = walletWith(brl('100.00'));
    const betRejeitada = persisted({
      kind: Kind.Bet,
      externalTransactionId: 'bet-1',
      status: Status.Rejected,
      failureCode: Code.InsufficientFunds,
    });
    const refund = reversal(Kind.Refund);

    const result = apply(wallet, refund, { reference: betRejeitada });

    expectRejectedWithoutEffect(wallet, refund, result, Code.ReferenceNotProcessed, '100.00');
  });
});

describe('ROLLBACK', () => {
  test('de BET: credita de volta', () => {
    const wallet = walletWith(brl('975.00'));
    const rollback = reversal(Kind.Rollback);

    const { ledgerEntry } = apply(wallet, rollback, { reference: processedBet() });

    expect(rollback.status).toBe(Status.Processed);
    expect(wallet.balance.toJSON().amount).toBe('1000.00');
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
  });

  test('de WIN: debita o prêmio', () => {
    const wallet = walletWith(brl('1025.00'));
    const win = persisted({ kind: Kind.Win, money: brl('50.00'), externalTransactionId: 'win-1' });
    const rollback = reversal(Kind.Rollback, '50.00', 'win-1');

    const { ledgerEntry } = apply(wallet, rollback, { reference: win });

    expect(rollback.status).toBe(Status.Processed);
    expect(wallet.balance.toJSON().amount).toBe('975.00');
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Debit);
  });

  test('de REFUND: debita o reembolso', () => {
    const wallet = walletWith(brl('1000.00'));
    const refund = persisted({
      kind: Kind.Refund,
      money: brl('25.00'),
      externalTransactionId: 'refund-1',
      referenceExternalTransactionId: 'bet-1',
    });
    const rollback = reversal(Kind.Rollback, '25.00', 'refund-1');

    const { ledgerEntry } = apply(wallet, rollback, { reference: refund });

    expect(wallet.balance.toJSON().amount).toBe('975.00');
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Debit);
  });

  test.each([Kind.Loss, Kind.Rollback, Kind.Opening])('não reverte %s', (referenceKind) => {
    const wallet = walletWith(brl('100.00'));
    const reference = persisted({ kind: referenceKind, externalTransactionId: 'bet-1' });
    const rollback = reversal(Kind.Rollback);

    const result = apply(wallet, rollback, { reference });

    expectRejectedWithoutEffect(wallet, rollback, result, Code.ReferenceKindNotAllowed, '100.00');
  });

  test('que deixaria o saldo negativo: REVERSAL_WOULD_OVERDRAW, distinto de INSUFFICIENT_FUNDS', () => {
    // O jogador ganhou 50.00 e já apostou quase tudo; reverter o WIN negativaria.
    const wallet = walletWith(brl('10.00'));
    const win = persisted({ kind: Kind.Win, money: brl('50.00'), externalTransactionId: 'win-1' });
    const rollback = reversal(Kind.Rollback, '50.00', 'win-1');

    const result = apply(wallet, rollback, { reference: win });

    expectRejectedWithoutEffect(wallet, rollback, result, Code.ReversalWouldOverdraw, '10.00');
    expect(rollback.failureCode).not.toBe(Code.InsufficientFunds);
  });

  test('valor diferente do da referência é rejeitado', () => {
    const wallet = walletWith(brl('100.00'));
    const rollback = reversal(Kind.Rollback, '30.00');

    const result = apply(wallet, rollback, { reference: processedBet('25.00') });

    expectRejectedWithoutEffect(wallet, rollback, result, Code.ReferenceAmountMismatch, '100.00');
  });

  test('uma transação não é revertida duas vezes', () => {
    const wallet = walletWith(brl('100.00'));
    const rollback = reversal(Kind.Rollback);

    const result = apply(wallet, rollback, { reference: processedBet(), referenceAlreadyReversed: true });

    expectRejectedWithoutEffect(wallet, rollback, result, Code.ReferenceAlreadyReversed, '100.00');
  });
});

describe('referência: mesmo provider, player, wallet, moeda e rodada', () => {
  test.each([
    ['outra rodada', { roundId: 'round-000' }],
    ['outro player', { playerId: 'player-2' }],
    ['outra wallet', { walletId: 'wallet-2' }],
    ['outro provider', { providerId: 'provider-b' }],
    ['outra moeda', { money: usd('25.00') }],
  ])('referência de %s é rejeitada', (_caso, difference) => {
    const wallet = walletWith(brl('100.00'));
    const reference = persisted({ kind: Kind.Bet, externalTransactionId: 'bet-1', ...difference });
    const refund = reversal(Kind.Refund);

    const result = apply(wallet, refund, { reference });

    expectRejectedWithoutEffect(wallet, refund, result, Code.ReferenceContextMismatch, '100.00');
  });
});

describe('referência fora de ordem (desafio 7.1)', () => {
  test('ROLLBACK antes da referência: PENDING_REFERENCE, sem tocar no saldo, com tentativa agendada', () => {
    const wallet = walletWith(brl('100.00'));
    const rollback = reversal(Kind.Rollback);

    const { ledgerEntry } = apply(wallet, rollback);

    expect(rollback.status).toBe(Status.PendingReference);
    expect(rollback.failureCode).toBeUndefined();
    expect(ledgerEntry).toBeUndefined();
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(rollback.nextReferenceAttemptAt).toEqual(new Date(NOW.getTime() + RETRY_POLICY.baseDelayMs));
  });

  test('quando a referência chega, a nova tentativa aplica o efeito', () => {
    const wallet = walletWith(brl('100.00'));
    const refund = reversal(Kind.Refund);
    apply(wallet, refund); // BET ainda não chegou

    // a BET chega e é processada; o worker tenta de novo
    const bet = submitted(Kind.Bet, brl('25.00'), { externalTransactionId: 'bet-1' });
    apply(wallet, bet);
    const { ledgerEntry } = apply(wallet, refund, { reference: bet });

    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(refund.nextReferenceAttemptAt).toBeUndefined();
  });

  test('tentativas frustradas são contadas e, esgotado o limite, vira REFERENCE_NOT_FOUND', () => {
    const wallet = walletWith(brl('100.00'));
    const rollback = reversal(Kind.Rollback);
    apply(wallet, rollback);

    for (let attempt = 1; attempt < RETRY_POLICY.maxAttempts; attempt++) {
      apply(wallet, rollback);
      expect(rollback.status).toBe(Status.PendingReference);
      expect(rollback.referenceAttempts).toBe(attempt);
    }
    const result = apply(wallet, rollback);

    expect(rollback.referenceAttempts).toBe(RETRY_POLICY.maxAttempts);
    expectRejectedWithoutEffect(wallet, rollback, result, Code.ReferenceNotFound, '100.00');
  });

  test('referência que ainda aguarda a própria referência mantém a dependente aguardando', () => {
    const wallet = walletWith(brl('100.00'));
    const refundPendente = persisted({
      kind: Kind.Refund,
      externalTransactionId: 'refund-1',
      referenceExternalTransactionId: 'bet-1',
      status: Status.PendingReference,
      processedAt: undefined,
    });
    const rollback = reversal(Kind.Rollback, '25.00', 'refund-1');

    const { ledgerEntry } = apply(wallet, rollback, { reference: refundPendente });

    expect(rollback.status).toBe(Status.PendingReference);
    expect(ledgerEntry).toBeUndefined();
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('referência inválida é rejeitada na hora, mesmo que ainda esteja pendente', () => {
    const wallet = walletWith(brl('100.00'));
    const refundPendente = persisted({
      kind: Kind.Refund,
      externalTransactionId: 'refund-1',
      referenceExternalTransactionId: 'bet-1',
      status: Status.PendingReference,
      processedAt: undefined,
    });
    // REFUND não pode referenciar outro REFUND: não adianta esperar.
    const refund = reversal(Kind.Refund, '25.00', 'refund-1');

    const result = apply(wallet, refund, { reference: refundPendente });

    expectRejectedWithoutEffect(wallet, refund, result, Code.ReferenceKindNotAllowed, '100.00');
  });
});

describe('wallet da operação', () => {
  test('conflito de moeda: operação em USD numa wallet BRL é rejeitada', () => {
    const wallet = walletWith(brl('100.00'));
    const bet = submitted(Kind.Bet, usd('25.00'));

    const result = apply(wallet, bet);

    expect(bet.status).toBe(Status.Rejected);
    expect(bet.failureCode).toBe(Code.CurrencyMismatch);
    expect(result.ledgerEntry).toBeUndefined();
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
  });

  test('conflito de moeda vale também para crédito', () => {
    const wallet = walletWith(brl('100.00'));
    const win = submitted(Kind.Win, usd('25.00'));

    apply(wallet, win);

    expect(win.failureCode).toBe(Code.CurrencyMismatch);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('wallet de outro player é rejeitada antes de qualquer outra regra', () => {
    const wallet = walletWith(brl('100.00'));
    // também está em outra moeda e sem saldo: o código que vence é o do player
    const bet = submitted(Kind.Bet, usd('9999.00'), { playerId: 'player-2' });

    const result = apply(wallet, bet);

    expect(bet.failureCode).toBe(Code.PlayerWalletMismatch);
    expect(result.ledgerEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });
});

describe('erros de quem chama (não viram rejeição de negócio)', () => {
  test('transação de outra wallet', () => {
    const wallet = walletWith(brl('100.00'));
    const bet = submitted(Kind.Bet, brl('25.00'), { walletId: 'wallet-2' });

    expect(() => apply(wallet, bet)).toThrow(DomainInvariantError);
    expect(bet.status).toBe(Status.Pending);
  });

  test('OPENING não passa pelas regras de aposta', () => {
    const wallet = walletWith(brl('100.00'));
    const opening = WagerTransaction.opening({
      id: 'tx-opening',
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: brl('100.00'),
      payloadHash: 'hash',
      createdAt: NOW,
    });

    expect(() => apply(wallet, opening)).toThrow(DomainInvariantError);
  });
});

describe('invariante final: saldo == ledger', () => {
  test('rodada completa com aplicações e rejeições', () => {
    const wallet = walletWith(brl('100.00'));
    const ledger: WalletLedgerEntry[] = [];
    const run = (tx: WagerTransaction, extra: Parameters<typeof apply>[2] = {}) => {
      const { ledgerEntry } = apply(wallet, tx, extra);
      if (ledgerEntry !== undefined) ledger.push(ledgerEntry);
      return tx;
    };

    const bet1 = run(submitted(Kind.Bet, brl('80.00'), { externalTransactionId: 'b1' })); // 20.00
    run(submitted(Kind.Bet, brl('80.00'))); // rejeitada
    const win = run(submitted(Kind.Win, brl('200.00'), { externalTransactionId: 'w1' })); // 220.00
    run(submitted(Kind.Loss, brl('10.00'))); // sem efeito
    run(reversal(Kind.Refund, '80.00', 'b1'), { reference: bet1 }); // 300.00
    run(reversal(Kind.Rollback, '200.00', 'w1'), { reference: win }); // 100.00
    run(reversal(Kind.Rollback, '80.00', 'b1'), { reference: bet1, referenceAlreadyReversed: true }); // rejeitada

    const fromLedger = ledger.reduce((total, entry) => total.add(entry.signedAmount()), brl('100.00'));
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(fromLedger.equals(wallet.balance)).toBe(true);
    expect(ledger).toHaveLength(4);
    expect(wallet.version).toBe(5);
  });
});
