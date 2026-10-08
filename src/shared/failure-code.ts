export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdrawWallet = 'REVERSAL_WOULD_OVERDRAW_WALLET',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceKindNotReversible = 'REFERENCE_KIND_NOT_REVERSIBLE',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReferenceScopeMismatch = 'REFERENCE_SCOPE_MISMATCH',
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
}
