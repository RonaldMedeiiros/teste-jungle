import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { OutboxRepository } from '../outbox/outbox.repository';
import { transactionProcessed, walletBalanceChanged } from '../outbox/outbox-message';
import { TransientFailureError, WalletAlreadyExistsError, WalletNotFoundError } from '../shared/errors';
import { isTransientDatabaseError, isUniqueViolation } from '../shared/database-errors';
import { AppLogger } from '../shared/logger';
import { AppMetrics } from '../shared/metrics';
import { Money, MoneyProps } from '../shared/money';
import { WagerTransaction, WagerTransactionKind } from '../wagering/wager-transaction';
import { WagerTransactionRepository } from '../wagering/wager-transaction.repository';
import { Wallet } from './wallet';
import { LedgerDirection } from './wallet-ledger-entry';
import { WalletRepository } from './wallet.repository';

export const LEDGER_DEFAULT_LIMIT = 50;

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerPageView {
  walletId: string;
  entries: Array<{
    id: string;
    transactionId: string;
    direction: LedgerDirection;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    createdAt: string;
  }>;
  nextCursor?: string;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class WalletService {
  constructor(
    private readonly orm: MikroORM,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly outbox: OutboxRepository,
    private readonly logger: AppLogger,
    private readonly metrics: AppMetrics,
  ) {}

  async open(playerId: string, initialBalanceProps: MoneyProps): Promise<WalletView> {
    const initialBalance = Money.from(initialBalanceProps);

    try {
      return await this.inTransaction(async (em) => {
        const existing = await this.wallets.findByPlayerAndCurrency(em, playerId, initialBalance.currency);
        if (existing) {
          throw new WalletAlreadyExistsError(playerId, initialBalance.currency);
        }

        const now = new Date();
        const wallet = Wallet.open({ id: uuidv7(), playerId, initialBalance, createdAt: now });
        await this.wallets.insert(em, wallet);

        if (initialBalance.isPositive()) {
          await this.recordOpening(em, wallet, initialBalance, now);
        }

        this.logger.info('wallet opened', {
          walletId: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
        });

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'wallets_player_currency_unique')) {
        throw new WalletAlreadyExistsError(playerId, initialBalance.currency);
      }
      if (isTransientDatabaseError(error)) {
        throw new TransientFailureError('database was unable to open the wallet');
      }
      throw error;
    }
  }

  private async recordOpening(em: EntityManager, wallet: Wallet, amount: Money, now: Date): Promise<void> {
    const externalTransactionId = `opening:${wallet.id}`;

    const opening = WagerTransaction.create({
      id: uuidv7(),
      providerId: 'internal',
      externalTransactionId,
      idempotencyKey: `internal:${externalTransactionId}`,
      payloadHash: 'opening'.padEnd(64, '0'),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: externalTransactionId,
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: amount,
      createdAt: now,
    });

    opening.markProcessed(undefined, now, wallet.balance);
    await this.transactions.insert(em, opening);

    const entry = wallet.openingLedgerEntry(uuidv7(), opening.id);
    if (!entry) {
      throw new Error('wallet opened with a positive balance but produced no opening ledger entry');
    }

    await this.wallets.appendLedgerEntry(em, entry);

    const context = { eventId: uuidv7(), correlationId: uuidv7(), causationId: opening.id, occurredAt: now };

    await this.outbox.addAll(em, [
      transactionProcessed(
        opening.id,
        {
          transactionId: opening.id,
          providerId: opening.providerId,
          externalTransactionId: opening.externalTransactionId,
          playerId: opening.playerId,
          walletId: opening.walletId,
          roundId: opening.roundId,
          gameId: opening.gameId,
          kind: opening.kind,
          money: opening.money.toJSON(),
          balanceAfter: wallet.balance.toJSON(),
        },
        context,
      ),
      walletBalanceChanged(
        wallet.id,
        {
          walletId: wallet.id,
          playerId: wallet.playerId,
          transactionId: opening.id,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        },
        { ...context, eventId: uuidv7() },
      ),
    ]);
  }

  async getById(walletId: string): Promise<WalletView> {
    const em = this.orm.em.fork() as EntityManager;
    const wallet = await this.wallets.findById(em, walletId);

    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  async getLedger(walletId: string, limit: number, cursor?: string): Promise<LedgerPageView> {
    const em = this.orm.em.fork() as EntityManager;
    const wallet = await this.wallets.findById(em, walletId);

    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    const page = await this.wallets.listLedger(em, walletId, limit, cursor);

    return {
      walletId,
      entries: page.entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  async reconcile(walletId: string): Promise<ReconciliationView> {
    return this.inTransaction(async (em) => {
      const wallet = await this.wallets.lockById(em, walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }

      const ledger = await this.wallets.sumLedger(em, walletId, wallet.currency);
      const difference = wallet.balance.subtract(ledger.total);
      const consistent = difference.isZero();

      await this.wallets.recordReconciliation(em, {
        id: uuidv7(),
        walletId,
        currency: wallet.currency,
        stored: wallet.balance,
        calculated: ledger.total,
        difference,
        consistent,
        checkedEntries: ledger.entries,
        checkedAt: new Date(),
      });

      if (consistent) {
        this.logger.info('wallet reconciliation passed', { walletId, checkedEntries: ledger.entries });
      } else {
        this.metrics.divergences.inc();
        this.logger.error('wallet balance diverged from ledger', {
          walletId,
          storedBalance: wallet.balance.toString(),
          calculatedBalance: ledger.total.toString(),
          difference: difference.toString(),
        });
      }

      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: ledger.total.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: ledger.entries,
      };
    });
  }

  private async inTransaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    const em = this.orm.em.fork() as EntityManager;
    return em.transactional(async (transactional) => work(transactional as EntityManager));
  }
}
