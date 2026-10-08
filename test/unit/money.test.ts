import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/shared/errors';
import { Money } from '../../src/shared/money';

describe('Money', () => {
  test('keeps a fixed scale of two decimal places', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toString()).toBe('25.00');
    expect(Money.from({ amount: '25.5', currency: 'BRL' }).toString()).toBe('25.50');
    expect(Money.from({ amount: '25.50', currency: 'BRL' }).toString()).toBe('25.50');
  });

  test('serializes back to the contract shape', () => {
    expect(Money.from({ amount: '1000.00', currency: 'BRL' }).toJSON()).toEqual({
      amount: '1000.00',
      currency: 'BRL',
    });
  });

  test('normalizes the currency to upper case', () => {
    expect(Money.from({ amount: '1.00', currency: 'brl' }).currency).toBe('BRL');
  });

  const invalidAmounts = ['', ' ', 'abc', 'NaN', 'Infinity', '1e3', '1E3', '25.001', '.5', '1,00'];

  for (const amount of invalidAmounts) {
    test(`rejects the invalid amount "${amount}"`, () => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });
  }

  test('rejects negative amounts on the input contract', () => {
    expect(() => Money.from({ amount: '-10.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('accepts negative amounts only through the signed factory', () => {
    expect(Money.fromSigned({ amount: '-10.00', currency: 'BRL' }).toString()).toBe('-10.00');
  });

  const invalidCurrencies = ['', 'BR', 'BRLL', '123', 'B1L'];

  for (const currency of invalidCurrencies) {
    test(`rejects the invalid currency "${currency}"`, () => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });
  }

  test('adds and subtracts without losing cents', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });
    expect(a.add(b).toString()).toBe('0.30');
    expect(b.subtract(a).toString()).toBe('0.10');
  });

  test('survives a long chain of cent additions that would drift with floats', () => {
    let total = Money.zero('BRL');
    for (let index = 0; index < 1000; index += 1) {
      total = total.add(Money.from({ amount: '0.01', currency: 'BRL' }));
    }
    expect(total.toString()).toBe('10.00');
  });

  test('is immutable', () => {
    const original = Money.from({ amount: '10.00', currency: 'BRL' });
    const sum = original.add(Money.from({ amount: '5.00', currency: 'BRL' }));
    expect(original.toString()).toBe('10.00');
    expect(sum.toString()).toBe('15.00');
    expect(sum).not.toBe(original);
  });

  test('allows subtraction below zero so the ledger can be verified', () => {
    const result = Money.from({ amount: '10.00', currency: 'BRL' }).subtract(
      Money.from({ amount: '15.00', currency: 'BRL' }),
    );
    expect(result.toString()).toBe('-5.00');
    expect(result.isNegative()).toBe(true);
  });

  test('throws when currencies differ', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });

  test('compares values', () => {
    const ten = Money.from({ amount: '10.00', currency: 'BRL' });
    const twenty = Money.from({ amount: '20.00', currency: 'BRL' });

    expect(ten.isLessThan(twenty)).toBe(true);
    expect(twenty.isLessThan(ten)).toBe(false);
    expect(ten.equals(Money.from({ amount: '10.00', currency: 'BRL' }))).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(ten.isPositive()).toBe(true);
    expect(ten.negate().isNegative()).toBe(true);
  });
});
