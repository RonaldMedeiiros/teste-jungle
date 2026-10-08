import { EntityManager, EntitySchema, LockMode } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { Money } from '../shared/money';
import { Wallet } from './wallet';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export class WalletEntity {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const walletSchema = new EntitySchema<WalletEntity>({
  class: WalletEntity,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', length: 3 },
    balanceAmount: { type: 'string', columnType: 'numeric(20,2)' },
    version: { type: 'number', columnType: 'integer' },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', columnType: 'timestamptz' },
  },
});

export class LedgerEntryEntity {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: LedgerDirection;
  currency!: string;
  amount!: string;
  balanceBeforeAmount!: string;
  balanceAfterAmount!: string;
  createdAt!: Date;
}

export const ledgerEntrySchema = new EntitySchema<LedgerEntryEntity>({
  class: LedgerEntryEntity,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { enum: true, items: () => LedgerDirection, type: 'string' },
    currency: { type: 'string', length: 3 },
    amount: { type: 'string', columnType: 'numeric(20,2)' },
    balanceBeforeAmount: { type: 'string', columnType: 'numeric(20,2)' },
    balanceAfterAmount: { type: 'string', columnType: 'numeric(20,2)' },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
  },
});

export class ReconciliationCheckEntity {
  id!: string;
  walletId!: string;
  currency!: string;
  storedAmount!: string;
  calculatedAmount!: string;
  differenceAmount!: string;
  consistent!: boolean;
  checkedEntries!: number;
  checkedAt!: Date;
}

export const reconciliationCheckSchema = new EntitySchema<ReconciliationCheckEntity>({
  class: ReconciliationCheckEntity,
  tableName: 'reconciliation_checks',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    currency: { type: 'string', length: 3 },
    storedAmount: { type: 'string', columnType: 'numeric(20,2)' },
    calculatedAmount: { type: 'string', columnType: 'numeric(20,2)' },
    differenceAmount: { type: 'string', columnType: 'numeric(20,2)' },
    consistent: { type: 'boolean' },
    checkedEntries: { type: 'number', columnType: 'integer' },
    checkedAt: { type: 'Date', columnType: 'timestamptz' },
  },
});

export interface LedgerSum {
  total: Money;
  entries: number;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

function toWallet(entity: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: entity.id,
    playerId: entity.playerId,
    currency: entity.currency,
    balance: Money.from({ amount: entity.balanceAmount, currency: entity.currency }),
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  });
}

function toLedgerEntry(entity: LedgerEntryEntity): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: entity.id,
    walletId: entity.walletId,
    transactionId: entity.transactionId,
    direction: entity.direction,
    money: Money.from({ amount: entity.amount, currency: entity.currency }),
    balanceBefore: Money.from({ amount: entity.balanceBeforeAmount, currency: entity.currency }),
    balanceAfter: Money.from({ amount: entity.balanceAfterAmount, currency: entity.currency }),
    createdAt: entity.createdAt,
  });
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { createdAt: string; id: string } {
  const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { createdAt?: string; id?: string };
  if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
    throw new Error('malformed ledger cursor');
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
}

@Injectable()
export class WalletRepository {
  async setLockTimeout(em: EntityManager, milliseconds: number): Promise<void> {
    await em.execute(`set local lock_timeout = '${milliseconds}ms'`);
  }

  async lockById(em: EntityManager, walletId: string): Promise<Wallet | null> {
    const entity = await em.findOne(WalletEntity, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return entity ? toWallet(entity) : null;
  }

  async findById(em: EntityManager, walletId: string): Promise<Wallet | null> {
    const entity = await em.findOne(WalletEntity, { id: walletId });
    return entity ? toWallet(entity) : null;
  }

  async findByPlayerAndCurrency(em: EntityManager, playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await em.findOne(WalletEntity, { playerId, currency });
    return entity ? toWallet(entity) : null;
  }

  async insert(em: EntityManager, wallet: Wallet): Promise<void> {
    const entity = new WalletEntity();
    entity.id = wallet.id;
    entity.playerId = wallet.playerId;
    entity.currency = wallet.currency;
    entity.balanceAmount = wallet.balance.toString();
    entity.version = wallet.version;
    entity.createdAt = wallet.createdAt;
    entity.updatedAt = wallet.updatedAt;
    em.persist(entity);
    await em.flush();
  }

  async saveBalance(em: EntityManager, wallet: Wallet): Promise<void> {
    const entity = await em.findOneOrFail(WalletEntity, { id: wallet.id });
    entity.balanceAmount = wallet.balance.toString();
    entity.version = wallet.version;
    entity.updatedAt = wallet.updatedAt;
    await em.flush();
  }

  async appendLedgerEntry(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    const entity = new LedgerEntryEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.currency = entry.money.currency;
    entity.amount = entry.money.toString();
    entity.balanceBeforeAmount = entry.balanceBefore.toString();
    entity.balanceAfterAmount = entry.balanceAfter.toString();
    entity.createdAt = entry.createdAt;
    em.persist(entity);
    await em.flush();
  }

  async sumLedger(em: EntityManager, walletId: string, currency: string): Promise<LedgerSum> {
    const rows = await em.execute<Array<{ total: string; entries: string }>>(
      `select
         coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20,2)::text as total,
         count(*)::text as entries
       from wallet_ledger_entries
       where wallet_id = ?`,
      [walletId],
    );

    const row = rows[0];
    if (!row) {
      return { total: Money.zero(currency), entries: 0 };
    }

    return {
      total: Money.fromSigned({ amount: row.total, currency }),
      entries: Number.parseInt(row.entries, 10),
    };
  }

  async listLedger(em: EntityManager, walletId: string, limit: number, cursor?: string): Promise<LedgerPage> {
    const where: Record<string, unknown> = { walletId };

    if (cursor) {
      const decoded = decodeCursor(cursor);
      where['$or'] = [
        { createdAt: { $lt: new Date(decoded.createdAt) } },
        { createdAt: new Date(decoded.createdAt), id: { $lt: decoded.id } },
      ];
    }

    const entities = await em.find(LedgerEntryEntity, where, {
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      limit: limit + 1,
    });

    const hasMore = entities.length > limit;
    const page = hasMore ? entities.slice(0, limit) : entities;
    const last = page[page.length - 1];

    return {
      entries: page.map(toLedgerEntry),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : undefined,
    };
  }

  async recordReconciliation(
    em: EntityManager,
    record: {
      id: string;
      walletId: string;
      currency: string;
      stored: Money;
      calculated: Money;
      difference: Money;
      consistent: boolean;
      checkedEntries: number;
      checkedAt: Date;
    },
  ): Promise<void> {
    const entity = new ReconciliationCheckEntity();
    entity.id = record.id;
    entity.walletId = record.walletId;
    entity.currency = record.currency;
    entity.storedAmount = record.stored.toString();
    entity.calculatedAmount = record.calculated.toString();
    entity.differenceAmount = record.difference.toString();
    entity.consistent = record.consistent;
    entity.checkedEntries = record.checkedEntries;
    entity.checkedAt = record.checkedAt;
    em.persist(entity);
    await em.flush();
  }
}
