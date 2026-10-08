import { FailureCode } from './failure-code';

export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(left: string, right: string) {
    super('CURRENCY_MISMATCH', `cannot operate on ${left} and ${right}`);
  }
}

export class InvalidWalletOperationError extends DomainError {
  constructor(message: string) {
    super('INVALID_WALLET_OPERATION', message);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(from: string, to: string) {
    super('INVALID_TRANSACTION_STATE', `cannot move transaction from ${from} to ${to}`);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super('INVALID_LEDGER_ENTRY', message);
  }
}

export class MissingReferenceError extends DomainError {
  constructor(kind: string) {
    super('MISSING_REFERENCE', `${kind} requires referenceExternalTransactionId`);
  }
}

export class InvalidRequestError extends Error {
  readonly code = 'INVALID_REQUEST';

  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(readonly idempotencyKey: string) {
    super(`idempotency key ${idempotencyKey} was already used with a different payload`);
    this.name = 'IdempotencyConflictError';
  }
}

export class WalletNotFoundError extends Error {
  readonly code = 'WALLET_NOT_FOUND';
  readonly failureCode = FailureCode.WalletNotFound;

  constructor(readonly walletId: string) {
    super(`wallet ${walletId} does not exist`);
    this.name = 'WalletNotFoundError';
  }
}

export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
    this.name = 'WalletAlreadyExistsError';
  }
}

export class TransactionNotFoundError extends Error {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`transaction ${reference} does not exist`);
    this.name = 'TransactionNotFoundError';
  }
}

export class TransientFailureError extends Error {
  readonly code = 'TRANSIENT_FAILURE';

  constructor(message: string) {
    super(message);
    this.name = 'TransientFailureError';
  }
}
