import { describe, expect, test } from 'bun:test';
import { brl, NOW, persisted, RETRY_POLICY, submitted } from '../../test/support/domain-fixtures';
import { DomainInvariantError, DomainValidationError, InvalidTransactionStateError } from './errors';
import { BusinessFailureCode, InfrastructureFailureCode } from './failure-code';
import { Money } from './money';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from './wager-transaction';
import { LedgerDirection } from './wallet-ledger-entry';

const BALANCE = brl('100.00');

describe('WagerTransaction.create', () => {
  test('nasce em PENDING, sem resultado', () => {
    const tx = submitted(Kind.Bet, brl('25.00'));

    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.observedBalance).toBeUndefined();
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.referenceAttempts).toBe(0);
  });

  test('OPENING é interno e não pode ser submetido', () => {
    expect(() => submitted(Kind.Opening, brl('25.00'))).toThrow(DomainValidationError);
  });

  test('providerId reservado às transações internas é recusado', () => {
    expect(() => submitted(Kind.Bet, brl('25.00'), { providerId: INTERNAL_PROVIDER_ID })).toThrow(
      DomainValidationError,
    );
  });

  test('kind desconhecido é recusado', () => {
    expect(() => submitted('CASHBACK' as Kind, brl('25.00'))).toThrow(DomainValidationError);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s exige referência', (kind) => {
    expect(() => submitted(kind, brl('25.00'))).toThrow(DomainValidationError);
    expect(() => submitted(kind, brl('25.00'), { referenceExternalTransactionId: '  ' })).toThrow(
      DomainValidationError,
    );
    expect(submitted(kind, brl('25.00'), { referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  test.each([Kind.Win, Kind.Loss])('%s aceita referência opcional', (kind) => {
    expect(submitted(kind, brl('25.00')).declaresReference()).toBe(false);
    expect(submitted(kind, brl('25.00'), { referenceExternalTransactionId: 'bet-1' }).declaresReference()).toBe(true);
    expect(submitted(kind, brl('25.00')).requiresReference()).toBe(false);
  });

  test('BET não pode declarar referência', () => {
    expect(() => submitted(Kind.Bet, brl('25.00'), { referenceExternalTransactionId: 'bet-1' })).toThrow(
      DomainValidationError,
    );
  });

  test('uma transação não pode referenciar a si mesma', () => {
    expect(() =>
      submitted(Kind.Rollback, brl('25.00'), {
        externalTransactionId: 'tx-123',
        referenceExternalTransactionId: 'tx-123',
      }),
    ).toThrow(DomainValidationError);
  });

  test.each([Kind.Bet, Kind.Win])('%s exige valor maior que zero', (kind) => {
    expect(() => submitted(kind, Money.zero('BRL'))).toThrow(DomainValidationError);
  });

  test('LOSS aceita valor zero, mas nenhum kind aceita negativo', () => {
    expect(submitted(Kind.Loss, Money.zero('BRL')).status).toBe(Status.Pending);
    expect(() => submitted(Kind.Loss, brl('1.00').negate())).toThrow(DomainValidationError);
  });

  test.each(['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId'] as const)(
    'campo obrigatório vazio: %s',
    (field) => {
      expect(() => submitted(Kind.Bet, brl('25.00'), { [field]: '' })).toThrow(DomainValidationError);
    },
  );
});

describe('WagerTransaction.opening', () => {
  test('cria a transação interna com chaves derivadas da wallet', () => {
    const opening = WagerTransaction.opening({
      id: 'tx-opening',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('1000.00'),
      payloadHash: 'hash',
      createdAt: NOW,
    });

    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.status).toBe(Status.Pending);
    expect(opening.providerId).toBe(INTERNAL_PROVIDER_ID);
    expect(opening.externalTransactionId).toBe('opening:wallet-1');
    expect(opening.idempotencyKey).toBe('internal:opening:wallet-1');
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('não existe OPENING de valor zero', () => {
    expect(() =>
      WagerTransaction.opening({
        id: 'tx-opening',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: Money.zero('BRL'),
        payloadHash: 'hash',
        createdAt: NOW,
      }),
    ).toThrow(DomainValidationError);
  });
});

describe('WagerTransaction — tabela de transições', () => {
  /** Transação com referência declarada, colocada no estado de origem como se viesse do banco. */
  function inStatus(status: Status): WagerTransaction {
    return persisted({
      kind: Kind.Refund,
      referenceExternalTransactionId: 'bet-1',
      status,
      processedAt: undefined,
    });
  }

  const transitions: Record<string, (tx: WagerTransaction) => void> = {
    markProcessed: (tx) => tx.markProcessed('ref-id', BALANCE, NOW),
    markPendingReference: (tx) => tx.markPendingReference(BALANCE, NOW, RETRY_POLICY),
    scheduleReferenceRetry: (tx) => tx.scheduleReferenceRetry(NOW, RETRY_POLICY),
    reject: (tx) => tx.reject(BusinessFailureCode.ReferenceNotFound, BALANCE),
    fail: (tx) => tx.fail(InfrastructureFailureCode.ProcessingFailed),
  };

  // undefined = transição inválida (InvalidTransactionStateError)
  const table: [from: Status, method: string, to: Status | undefined][] = [
    [Status.Pending, 'markProcessed', Status.Processed],
    [Status.Pending, 'markPendingReference', Status.PendingReference],
    [Status.Pending, 'scheduleReferenceRetry', undefined],
    [Status.Pending, 'reject', Status.Rejected],
    [Status.Pending, 'fail', Status.Failed],

    [Status.PendingReference, 'markProcessed', Status.Processed],
    [Status.PendingReference, 'markPendingReference', undefined],
    [Status.PendingReference, 'scheduleReferenceRetry', Status.PendingReference],
    [Status.PendingReference, 'reject', Status.Rejected],
    [Status.PendingReference, 'fail', Status.Failed],

    ...[Status.Processed, Status.Rejected, Status.Failed].flatMap((terminal) =>
      Object.keys(transitions).map((method): [Status, string, undefined] => [terminal, method, undefined]),
    ),
  ];

  test.each(table)('%s --%s--> %p', (from, method, to) => {
    const tx = inStatus(from);
    const apply = transitions[method] as (tx: WagerTransaction) => void;

    if (to === undefined) {
      expect(() => apply(tx)).toThrow(InvalidTransactionStateError);
      expect(tx.status).toBe(from);
    } else {
      apply(tx);
      expect(tx.status).toBe(to);
    }
  });

  test('a tabela cobre as 5 origens x 5 métodos', () => {
    expect(table).toHaveLength(25);
  });

  test.each([Status.Processed, Status.Rejected, Status.Failed])('%s é terminal', (status) => {
    expect(inStatus(status).isTerminal()).toBe(true);
  });

  test.each([Status.Pending, Status.PendingReference])('%s não é terminal', (status) => {
    expect(inStatus(status).isTerminal()).toBe(false);
  });
});

describe('WagerTransaction — efeitos das transições', () => {
  test('markProcessed grava referência resolvida, saldo observado e data', () => {
    const tx = submitted(Kind.Refund, brl('25.00'), { referenceExternalTransactionId: 'bet-1' });

    tx.markProcessed('id-interno-da-bet', brl('125.00'), NOW);

    expect(tx.referenceTransactionId).toBe('id-interno-da-bet');
    expect(tx.observedBalance?.toJSON().amount).toBe('125.00');
    expect(tx.processedAt).toBe(NOW);
    expect(tx.failureCode).toBeUndefined();
  });

  test('markProcessed exige a referência resolvida quando ela foi declarada, e só nesse caso', () => {
    const comReferencia = submitted(Kind.Refund, brl('25.00'), { referenceExternalTransactionId: 'bet-1' });
    const semReferencia = submitted(Kind.Bet, brl('25.00'));

    expect(() => comReferencia.markProcessed(undefined, BALANCE, NOW)).toThrow(DomainInvariantError);
    expect(() => semReferencia.markProcessed('qualquer', BALANCE, NOW)).toThrow(DomainInvariantError);
    expect(comReferencia.status).toBe(Status.Pending);
    expect(semReferencia.status).toBe(Status.Pending);
  });

  test('markPendingReference só vale para quem declarou referência', () => {
    expect(() => submitted(Kind.Bet, brl('25.00')).markPendingReference(BALANCE, NOW, RETRY_POLICY)).toThrow(
      DomainInvariantError,
    );
  });

  test('markPendingReference agenda a primeira tentativa com o atraso base', () => {
    const tx = submitted(Kind.Rollback, brl('25.00'), { referenceExternalTransactionId: 'bet-1' });

    tx.markPendingReference(BALANCE, NOW, RETRY_POLICY);

    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceAttemptAt).toEqual(new Date(NOW.getTime() + 1_000));
    expect(tx.observedBalance?.equals(BALANCE)).toBe(true);
  });

  test('scheduleReferenceRetry conta a tentativa e dobra o atraso até o teto', () => {
    const tx = submitted(Kind.Rollback, brl('25.00'), { referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(BALANCE, NOW, RETRY_POLICY);

    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      tx.scheduleReferenceRetry(NOW, RETRY_POLICY);
      delays.push((tx.nextReferenceAttemptAt as Date).getTime() - NOW.getTime());
    }

    expect(tx.referenceAttempts).toBe(8);
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  test('hasExhaustedReferenceAttempts compara com o limite da política', () => {
    const tx = submitted(Kind.Rollback, brl('25.00'), { referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(BALANCE, NOW, RETRY_POLICY);

    tx.scheduleReferenceRetry(NOW, RETRY_POLICY);
    tx.scheduleReferenceRetry(NOW, RETRY_POLICY);
    expect(tx.hasExhaustedReferenceAttempts(3)).toBe(false);

    tx.scheduleReferenceRetry(NOW, RETRY_POLICY);
    expect(tx.hasExhaustedReferenceAttempts(3)).toBe(true);
  });

  test('reject grava o failureCode e o saldo observado, e cancela novas tentativas', () => {
    const tx = submitted(Kind.Rollback, brl('25.00'), { referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(BALANCE, NOW, RETRY_POLICY);

    tx.reject(BusinessFailureCode.ReferenceNotFound, brl('70.00'));

    expect(tx.failureCode).toBe(BusinessFailureCode.ReferenceNotFound);
    expect(tx.observedBalance?.toJSON().amount).toBe('70.00');
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
  });

  test('fail grava o código de infraestrutura', () => {
    const tx = submitted(Kind.Bet, brl('25.00'));

    tx.fail(InfrastructureFailureCode.ProcessingFailed);

    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(InfrastructureFailureCode.ProcessingFailed);
  });
});

describe('WagerTransaction — consultas de domínio', () => {
  test('affectsBalance é false apenas para LOSS', () => {
    expect(submitted(Kind.Loss, brl('25.00')).affectsBalance()).toBe(false);
    expect(submitted(Kind.Bet, brl('25.00')).affectsBalance()).toBe(true);
    expect(submitted(Kind.Win, brl('25.00')).affectsBalance()).toBe(true);
    expect(submitted(Kind.Refund, brl('25.00'), { referenceExternalTransactionId: 'b' }).affectsBalance()).toBe(true);
    expect(submitted(Kind.Rollback, brl('25.00'), { referenceExternalTransactionId: 'b' }).affectsBalance()).toBe(true);
  });

  test('direção fixa: BET debita; WIN e REFUND creditam', () => {
    expect(submitted(Kind.Bet, brl('25.00')).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(submitted(Kind.Win, brl('25.00')).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      submitted(Kind.Refund, brl('25.00'), { referenceExternalTransactionId: 'b' }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  test.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
    [Kind.Refund, LedgerDirection.Debit],
  ])('ROLLBACK de %s lança o inverso: %s', (referenceKind, expected) => {
    const rollback = submitted(Kind.Rollback, brl('25.00'), { referenceExternalTransactionId: 'ref' });
    const reference = persisted({
      kind: referenceKind,
      referenceExternalTransactionId: referenceKind === Kind.Refund ? 'bet-0' : undefined,
    });

    expect(rollback.ledgerDirectionFor(reference)).toBe(expected);
  });

  test('ROLLBACK sem a referência e LOSS não têm direção', () => {
    const rollback = submitted(Kind.Rollback, brl('25.00'), { referenceExternalTransactionId: 'ref' });

    expect(() => rollback.ledgerDirectionFor()).toThrow(DomainInvariantError);
    expect(() => submitted(Kind.Loss, brl('25.00')).ledgerDirectionFor()).toThrow(DomainInvariantError);
  });
});

describe('WagerTransaction — idempotency key com payload divergente', () => {
  test('mesmo hash é replay; hash diferente é conflito', () => {
    const tx = submitted(Kind.Bet, brl('25.00'), { payloadHash: 'sha256:aaa' });

    expect(tx.matchesPayload('sha256:aaa')).toBe(true);
    expect(tx.matchesPayload('sha256:bbb')).toBe(false);
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('reconstrói qualquer estado sem revalidar regras de criação ou de transição', () => {
    // OPENING terminal, com provider interno e valor zero: tudo que `create` recusaria.
    const tx = persisted({
      kind: Kind.Opening,
      providerId: INTERNAL_PROVIDER_ID,
      money: Money.zero('BRL'),
      status: Status.Rejected,
      failureCode: BusinessFailureCode.InsufficientFunds,
      processedAt: undefined,
      observedBalance: brl('10.00'),
      referenceAttempts: 7,
    });

    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(BusinessFailureCode.InsufficientFunds);
    expect(tx.referenceAttempts).toBe(7);
    expect(tx.observedBalance?.toJSON().amount).toBe('10.00');
  });
});
