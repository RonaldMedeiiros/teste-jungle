import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, MissingReferenceError } from '../../src/shared/errors';
import { FailureCode } from '../../src/shared/failure-code';
import { Money } from '../../src/shared/money';
import { LedgerDirection } from '../../src/wallet/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/wagering/wager-transaction';

const NOW = new Date('2026-07-29T15:00:00.000Z');

function build(
  kind: WagerTransactionKind,
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt: NOW,
    ...overrides,
  });
}

describe('WagerTransaction creation', () => {
  test('is born pending', () => {
    expect(build(WagerTransactionKind.Bet).status).toBe(WagerTransactionStatus.Pending);
    expect(build(WagerTransactionKind.Bet).isTerminal()).toBe(false);
  });

  test('requires a reference for refund and rollback', () => {
    expect(() => build(WagerTransactionKind.Refund)).toThrow(MissingReferenceError);
    expect(() => build(WagerTransactionKind.Rollback)).toThrow(MissingReferenceError);
  });

  test('does not require a reference for bet, win and loss', () => {
    expect(build(WagerTransactionKind.Bet).requiresReference()).toBe(false);
    expect(build(WagerTransactionKind.Win).requiresReference()).toBe(false);
    expect(build(WagerTransactionKind.Loss).requiresReference()).toBe(false);
  });

  test('refuses to reference itself', () => {
    expect(() => build(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'transaction-123' })).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('refuses a zero amount', () => {
    expect(() => build(WagerTransactionKind.Bet, { money: Money.zero('BRL') })).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction domain questions', () => {
  test('loss does not affect the balance', () => {
    expect(build(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
    expect(build(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
    expect(build(WagerTransactionKind.Win).affectsBalance()).toBe(true);
  });

  test('maps each kind to a ledger direction', () => {
    expect(build(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(build(WagerTransactionKind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(build(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'bet-1' }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  test('a rollback inverts the direction of its reference', () => {
    const rollback = build(WagerTransactionKind.Rollback, { referenceExternalTransactionId: 'bet-1' });
    const bet = build(WagerTransactionKind.Bet, { id: 'tx-bet', externalTransactionId: 'bet-1' });
    const win = build(WagerTransactionKind.Win, { id: 'tx-win', externalTransactionId: 'win-1' });

    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  test('a rollback without a reference cannot pick a direction', () => {
    const rollback = build(WagerTransactionKind.Rollback, { referenceExternalTransactionId: 'bet-1' });
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('a loss has no ledger direction at all', () => {
    expect(() => build(WagerTransactionKind.Loss).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('compares payload hashes', () => {
    const transaction = build(WagerTransactionKind.Bet);
    expect(transaction.matchesPayload('hash-1')).toBe(true);
    expect(transaction.matchesPayload('hash-2')).toBe(false);
  });
});

describe('WagerTransaction transitions', () => {
  test('pending can be processed', () => {
    const transaction = build(WagerTransactionKind.Bet);
    transaction.markProcessed(undefined, NOW, Money.from({ amount: '75.00', currency: 'BRL' }));

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.processedAt).toEqual(NOW);
    expect(transaction.observedBalance?.toString()).toBe('75.00');
    expect(transaction.isTerminal()).toBe(true);
  });

  test('pending can be rejected with a failure code', () => {
    const transaction = build(WagerTransactionKind.Bet);
    transaction.reject(FailureCode.InsufficientFunds, NOW, Money.from({ amount: '10.00', currency: 'BRL' }));

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction.observedBalance?.toString()).toBe('10.00');
    expect(transaction.isTerminal()).toBe(true);
  });

  const terminalSetups: Array<[string, (transaction: WagerTransaction) => void]> = [
    ['processed', (transaction) => transaction.markProcessed(undefined, NOW, Money.zero('BRL'))],
    ['rejected', (transaction) => transaction.reject(FailureCode.InsufficientFunds, NOW, Money.zero('BRL'))],
  ];

  for (const [label, settle] of terminalSetups) {
    test(`a ${label} transaction refuses any further transition`, () => {
      const transaction = build(WagerTransactionKind.Bet);
      settle(transaction);

      expect(transaction.isTerminal()).toBe(true);
      expect(() => transaction.markProcessed(undefined, NOW, Money.zero('BRL'))).toThrow(InvalidTransactionStateError);
      expect(() => transaction.reject(FailureCode.InsufficientFunds, NOW, Money.zero('BRL'))).toThrow(
        InvalidTransactionStateError,
      );
    });
  }

  test('rehydrate restores a stored state without replaying the transitions', () => {
    const transaction = WagerTransaction.rehydrate({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      payloadHash: 'hash-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      createdAt: NOW,
      status: WagerTransactionStatus.Processed,
      processedAt: NOW,
      observedBalance: Money.from({ amount: '75.00', currency: 'BRL' }),
    });

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.observedBalance?.toString()).toBe('75.00');
  });
});
