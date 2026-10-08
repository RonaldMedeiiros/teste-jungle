import { EntityManager, EntitySchema } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { FailureCode } from '../shared/failure-code';
import { Money } from '../shared/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

export class WagerTransactionEntity {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  currency!: string;
  amount!: string;
  referenceExternalTransactionId?: string;
  status!: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  observedBalanceAmount?: string;
  createdAt!: Date;
  processedAt?: Date;
}

export const wagerTransactionSchema = new EntitySchema<WagerTransactionEntity>({
  class: WagerTransactionEntity,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', length: 64 },
    externalTransactionId: { type: 'string', length: 128 },
    idempotencyKey: { type: 'string', length: 255 },
    payloadHash: { type: 'string', length: 64 },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string', length: 128 },
    gameId: { type: 'string', length: 128 },
    kind: { enum: true, items: () => WagerTransactionKind, type: 'string' },
    currency: { type: 'string', length: 3 },
    amount: { type: 'string', columnType: 'numeric(20,2)' },
    referenceExternalTransactionId: { type: 'string', length: 128, nullable: true },
    status: { enum: true, items: () => WagerTransactionStatus, type: 'string' },
    referenceTransactionId: { type: 'uuid', nullable: true },
    failureCode: { enum: true, items: () => FailureCode, type: 'string', nullable: true },
    observedBalanceAmount: { type: 'string', columnType: 'numeric(20,2)', nullable: true },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
    processedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
  },
});

function toTransaction(entity: WagerTransactionEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash,
    walletId: entity.walletId,
    playerId: entity.playerId,
    roundId: entity.roundId,
    gameId: entity.gameId,
    kind: entity.kind,
    money: Money.from({ amount: entity.amount, currency: entity.currency }),
    referenceExternalTransactionId: entity.referenceExternalTransactionId,
    createdAt: entity.createdAt,
    status: entity.status,
    referenceTransactionId: entity.referenceTransactionId,
    failureCode: entity.failureCode,
    observedBalance: entity.observedBalanceAmount
      ? Money.from({ amount: entity.observedBalanceAmount, currency: entity.currency })
      : undefined,
    processedAt: entity.processedAt,
  });
}

@Injectable()
export class WagerTransactionRepository {
  async findById(em: EntityManager, id: string): Promise<WagerTransaction | null> {
    const entity = await em.findOne(WagerTransactionEntity, { id });
    return entity ? toTransaction(entity) : null;
  }

  async findByIdempotencyKey(em: EntityManager, idempotencyKey: string): Promise<WagerTransaction | null> {
    const entity = await em.findOne(WagerTransactionEntity, { idempotencyKey });
    return entity ? toTransaction(entity) : null;
  }

  async findByProviderAndExternalId(
    em: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    return entity ? toTransaction(entity) : null;
  }

  async insert(em: EntityManager, transaction: WagerTransaction): Promise<void> {
    const entity = new WagerTransactionEntity();
    entity.id = transaction.id;
    entity.providerId = transaction.providerId;
    entity.externalTransactionId = transaction.externalTransactionId;
    entity.idempotencyKey = transaction.idempotencyKey;
    entity.payloadHash = transaction.payloadHash;
    entity.walletId = transaction.walletId;
    entity.playerId = transaction.playerId;
    entity.roundId = transaction.roundId;
    entity.gameId = transaction.gameId;
    entity.kind = transaction.kind;
    entity.currency = transaction.money.currency;
    entity.amount = transaction.money.toString();
    entity.referenceExternalTransactionId = transaction.referenceExternalTransactionId;
    entity.status = transaction.status;
    entity.referenceTransactionId = transaction.referenceTransactionId;
    entity.failureCode = transaction.failureCode;
    entity.observedBalanceAmount = transaction.observedBalance?.toString();
    entity.createdAt = transaction.createdAt;
    entity.processedAt = transaction.processedAt;
    em.persist(entity);
    await em.flush();
  }

  async hasProcessedReversal(
    em: EntityManager,
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean> {
    const found = await em.count(WagerTransactionEntity, {
      providerId,
      referenceExternalTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return found > 0;
  }
}
