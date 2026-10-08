import { describe, expect, test } from 'bun:test';
import { InvalidLedgerEntryError } from '../../src/shared/errors';
import { Money } from '../../src/shared/money';
import { LedgerDirection, WalletLedgerEntry } from '../../src/wallet/wallet-ledger-entry';

const NOW = new Date('2026-07-29T15:00:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function build(direction: LedgerDirection, amount: string, before: string, after: string): WalletLedgerEntry {
  return WalletLedgerEntry.create({
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction,
    money: brl(amount),
    balanceBefore: brl(before),
    balanceAfter: brl(after),
    createdAt: NOW,
  });
}

describe('WalletLedgerEntry', () => {
  test('accepts a balanced debit', () => {
    const entry = build(LedgerDirection.Debit, '25.00', '100.00', '75.00');
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().toString()).toBe('-25.00');
  });

  test('accepts a balanced credit', () => {
    const entry = build(LedgerDirection.Credit, '25.00', '100.00', '125.00');
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().toString()).toBe('25.00');
  });

  test('rejects broken arithmetic', () => {
    expect(() => build(LedgerDirection.Debit, '25.00', '100.00', '80.00')).toThrow(InvalidLedgerEntryError);
    expect(() => build(LedgerDirection.Credit, '25.00', '100.00', '120.00')).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a non positive amount', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Credit,
        money: Money.zero('BRL'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('100.00'),
        createdAt: NOW,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: brl('150.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: Money.fromSigned({ amount: '-50.00', currency: 'BRL' }),
        createdAt: NOW,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects mixed currencies', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '25.00', currency: 'USD' }),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('75.00'),
        createdAt: NOW,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('exposes no mutators', () => {
    const mutators = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
      (name) => name.startsWith('mark') || name.startsWith('set') || name.startsWith('apply'),
    );

    expect(mutators).toEqual([]);
  });
});
