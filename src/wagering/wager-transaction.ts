import { FailureCode } from '../shared/failure-code';
import { InvalidTransactionStateError, MissingReferenceError } from '../shared/errors';
import { Money } from '../shared/money';
import { LedgerDirection, invertDirection } from '../wallet/wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
}

export const KINDS_REQUIRING_REFERENCE: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export const KINDS_WITHOUT_BALANCE_EFFECT: ReadonlySet<WagerTransactionKind> = new Set([WagerTransactionKind.Loss]);

export const REVERSIBLE_BY: ReadonlyMap<WagerTransactionKind, ReadonlySet<WagerTransactionKind>> = new Map([
  [WagerTransactionKind.Refund, new Set([WagerTransactionKind.Bet])],
  [
    WagerTransactionKind.Rollback,
    new Set([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]),
  ],
]);

export function isSubmittableKind(kind: WagerTransactionKind): boolean {
  return kind !== WagerTransactionKind.Opening;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  observedBalance?: Money;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _observedBalance?: Money,
    private _processedAt?: Date,
  ) {}

  static create(props: Omit<WagerTransactionState, 'status' | 'referenceTransactionId' | 'failureCode' | 'observedBalance' | 'processedAt'>): WagerTransaction {
    if (KINDS_REQUIRING_REFERENCE.has(props.kind) && !props.referenceExternalTransactionId) {
      throw new MissingReferenceError(props.kind);
    }
    if (!props.money.isPositive()) {
      throw new InvalidTransactionStateError('invalid-amount', `${props.kind} requires a positive amount`);
    }
    if (props.referenceExternalTransactionId === props.externalTransactionId) {
      throw new InvalidTransactionStateError('self-reference', 'transaction cannot reference itself');
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.observedBalance,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._observedBalance = observedBalance;
    this._processedAt = at;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._processedAt = at;
  }

  isTerminal(): boolean {
    return this._status !== WagerTransactionStatus.Pending;
  }

  affectsBalance(): boolean {
    return !KINDS_WITHOUT_BALANCE_EFFECT.has(this.kind);
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (!this.affectsBalance()) {
      throw new InvalidTransactionStateError(this.kind, 'ledger-direction');
    }

    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError(this.kind, 'ledger-direction-without-reference');
        }
        return invertDirection(reference.ledgerDirectionFor());
      }
      default:
        throw new InvalidTransactionStateError(this.kind, 'ledger-direction');
    }
  }

  private assertNotTerminal(next: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, next);
    }
  }
}
