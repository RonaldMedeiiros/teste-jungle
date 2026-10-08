import { MoneyProps } from '../shared/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';

export interface EventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export interface OutboxRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: EventEnvelope<unknown>;
  occurredAt: Date;
}

export interface TransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  balanceAfter: MoneyProps;
  referenceTransactionId?: string;
}

export interface TransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
  failureCode: string;
}

export interface BalanceChangedData {
  walletId: string;
  playerId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export function buildEvent<T>(
  eventType: string,
  aggregateId: string,
  data: T,
  context: EventContext,
): OutboxRecord {
  const envelope: EventEnvelope<T> = {
    eventId: context.eventId,
    eventType,
    aggregateId,
    correlationId: context.correlationId,
    occurredAt: context.occurredAt.toISOString(),
    version: 1,
    data,
  };

  if (context.causationId !== undefined) {
    envelope.causationId = context.causationId;
  }

  return {
    id: context.eventId,
    aggregateId,
    eventType,
    payload: envelope as EventEnvelope<unknown>,
    occurredAt: context.occurredAt,
  };
}

export function transactionProcessed(
  aggregateId: string,
  data: TransactionProcessedData,
  context: EventContext,
): OutboxRecord {
  return buildEvent('WagerTransactionProcessed', aggregateId, data, context);
}

export function transactionRejected(
  aggregateId: string,
  data: TransactionRejectedData,
  context: EventContext,
): OutboxRecord {
  return buildEvent('WagerTransactionRejected', aggregateId, data, context);
}

export function walletBalanceChanged(
  aggregateId: string,
  data: BalanceChangedData,
  context: EventContext,
): OutboxRecord {
  return buildEvent('WalletBalanceChanged', aggregateId, data, context);
}
