import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidWalletOperationError } from '../../src/shared/errors';
import { Money } from '../../src/shared/money';
import { Wallet } from '../../src/wallet/wallet';
import { LedgerDirection } from '../../src/wallet/wallet-ledger-entry';

const NOW = new Date('2026-07-29T15:00:00.000Z');

function openWallet(amount: string, currency = 'BRL'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount, currency }),
    createdAt: NOW,
  });
}

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

describe('Wallet', () => {
  test('opens at version 1 with the initial balance', () => {
    const wallet = openWallet('100.00');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
  });

  test('derives its currency from the initial balance', () => {
    expect(openWallet('0.00', 'USD').currency).toBe('USD');
  });

  test('produces an opening ledger entry from zero to the initial balance', () => {
    const wallet = openWallet('1000.00');
    const entry = wallet.openingLedgerEntry('entry-1', 'tx-1');

    expect(entry).toBeDefined();
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.toString()).toBe('0.00');
    expect(entry?.balanceAfter.toString()).toBe('1000.00');
    expect(entry?.isBalanced()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('produces no opening entry when the wallet starts empty', () => {
    expect(openWallet('0.00').openingLedgerEntry('entry-1', 'tx-1')).toBeUndefined();
  });

  test('debits and bumps the version', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit({ entryId: 'entry-1', transactionId: 'tx-1', money: brl('25.00'), at: NOW });

    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');
  });

  test('credits and bumps the version', () => {
    const wallet = openWallet('100.00');
    wallet.credit({ entryId: 'entry-1', transactionId: 'tx-1', money: brl('50.00'), at: NOW });

    expect(wallet.balance.toString()).toBe('150.00');
    expect(wallet.version).toBe(2);
  });

  test('allows a debit that empties the wallet exactly', () => {
    const wallet = openWallet('100.00');
    wallet.debit({ entryId: 'entry-1', transactionId: 'tx-1', money: brl('100.00'), at: NOW });
    expect(wallet.balance.toString()).toBe('0.00');
  });

  test('never allows the balance to go negative', () => {
    const wallet = openWallet('100.00');

    expect(() =>
      wallet.debit({ entryId: 'entry-1', transactionId: 'tx-1', money: brl('100.01'), at: NOW }),
    ).toThrow(InvalidWalletOperationError);

    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('canDebit answers before the movement is attempted', () => {
    const wallet = openWallet('100.00');
    expect(wallet.canDebit(brl('100.00'))).toBe(true);
    expect(wallet.canDebit(brl('100.01'))).toBe(false);
  });

  test('refuses operations in a different currency', () => {
    const wallet = openWallet('100.00');
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => wallet.canDebit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit({ entryId: 'e', transactionId: 't', money: usd, at: NOW })).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit({ entryId: 'e', transactionId: 't', money: usd, at: NOW })).toThrow(
      CurrencyMismatchError,
    );
  });

  test('refuses a zero movement', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit({ entryId: 'e', transactionId: 't', money: Money.zero('BRL'), at: NOW })).toThrow(
      InvalidWalletOperationError,
    );
  });

  test('keeps the balance and the ledger entries in agreement', () => {
    const wallet = openWallet('100.00');
    const entries = [
      wallet.debit({ entryId: 'e1', transactionId: 't1', money: brl('30.00'), at: NOW }),
      wallet.credit({ entryId: 'e2', transactionId: 't2', money: brl('45.00'), at: NOW }),
      wallet.debit({ entryId: 'e3', transactionId: 't3', money: brl('15.00'), at: NOW }),
    ];

    const replayed = entries.reduce((total, entry) => total.add(entry.signedAmount()), brl('100.00'));

    expect(replayed.toString()).toBe(wallet.balance.toString());
    expect(wallet.version).toBe(4);
    for (const entry of entries) {
      expect(entry.isBalanced()).toBe(true);
    }
  });

  test('rehydrates without revalidating transitions', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: brl('7.77'),
      version: 42,
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(wallet.balance.toString()).toBe('7.77');
    expect(wallet.version).toBe(42);
  });
});
