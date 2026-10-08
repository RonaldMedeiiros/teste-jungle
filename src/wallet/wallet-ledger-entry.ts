import { InvalidLedgerEntryError } from '../shared/errors';
import { Money } from '../shared/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export function invertDirection(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );

    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('ledger entry amount must be positive');
    }
    if (!props.money.hasSameCurrency(props.balanceBefore) || !props.money.hasSameCurrency(props.balanceAfter)) {
      throw new InvalidLedgerEntryError('ledger entry mixes currencies');
    }
    if (props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('ledger entry would leave a negative balance');
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `ledger arithmetic broken: ${props.balanceBefore.toString()} ${props.direction} ${props.money.toString()} != ${props.balanceAfter.toString()}`,
      );
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
