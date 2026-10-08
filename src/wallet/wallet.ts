import { CurrencyMismatchError, InvalidWalletOperationError } from '../shared/errors';
import { Money } from '../shared/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; createdAt: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletOperationError('initial balance must not be negative');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.createdAt,
      props.createdAt,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  openingLedgerEntry(entryId: string, transactionId: string): WalletLedgerEntry | undefined {
    if (this._version !== 1 || !this._balance.isPositive()) {
      return undefined;
    }

    return WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: this.createdAt,
    });
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    return this.applyMovement(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    return this.applyMovement(LedgerDirection.Credit, props);
  }

  applyMovement(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new InvalidWalletOperationError('movement amount must be positive');
    }

    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(props.money) : balanceBefore.subtract(props.money);

    if (balanceAfter.isNegative()) {
      throw new InvalidWalletOperationError(
        `movement would leave a negative balance: ${balanceBefore.toString()} - ${props.money.toString()}`,
      );
    }

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: props.at,
    });

    this._balance = balanceAfter;
    this._version = this._version + 1;
    this._updatedAt = props.at;

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
