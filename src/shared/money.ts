import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });

export const MONEY_SCALE = 2;

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const SIGNED_AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    return new Money(Money.parseAmount(props.amount, AMOUNT_PATTERN), Money.parseCurrency(props.currency));
  }

  static fromSigned(props: MoneyProps): Money {
    return new Money(Money.parseAmount(props.amount, SIGNED_AMOUNT_PATTERN), Money.parseCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.parseCurrency(currency));
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string') {
      throw new InvalidMoneyError('currency must be a string');
    }
    const normalized = currency.trim().toUpperCase();
    if (!CURRENCY_PATTERN.test(normalized)) {
      throw new InvalidMoneyError(`currency must be a 3 letter ISO-4217 code, received "${currency}"`);
    }
    return normalized;
  }

  private static parseAmount(amount: unknown, pattern: RegExp): Decimal {
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    const trimmed = amount.trim();
    if (trimmed.length === 0) {
      throw new InvalidMoneyError('amount must not be empty');
    }
    if (!pattern.test(trimmed)) {
      throw new InvalidMoneyError(
        `amount must be a plain decimal string with at most ${MONEY_SCALE} decimal places, received "${amount}"`,
      );
    }
    const decimal = new Decimal(trimmed);
    if (!decimal.isFinite()) {
      throw new InvalidMoneyError(`amount must be finite, received "${amount}"`);
    }
    return decimal.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  hasSameCurrency(other: Money): boolean {
    return this.currency === other.currency;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
