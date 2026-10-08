import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { OutboxRecord, transactionProcessed, transactionRejected, walletBalanceChanged } from '../outbox/outbox-message';
import { OutboxRepository } from '../outbox/outbox.repository';
import { isLockConflict, isTransientDatabaseError, isUniqueViolation } from '../shared/database-errors';
import { IdempotencyConflictError, TransientFailureError, WalletNotFoundError } from '../shared/errors';
import { FailureCode } from '../shared/failure-code';
import { AppLogger } from '../shared/logger';
import { AppMetrics } from '../shared/metrics';
import { Money, MoneyProps } from '../shared/money';
import { computePayloadHash } from '../shared/payload-hash';
import { Wallet } from '../wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { WalletRepository } from '../wallet/wallet.repository';
import {
  REVERSIBLE_BY,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';
import { WagerTransactionRepository } from './wager-transaction.repository';

const MAX_ATTEMPTS = 4;
const LOCK_TIMEOUT_MS = Number.parseInt(process.env['WALLET_LOCK_TIMEOUT_MS'] ?? '5000', 10);

export interface SubmitCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface SubmitResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balanceAfter?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

type ReferenceOutcome =
  | { outcome: 'resolved'; reference: WagerTransaction }
  | { outcome: 'rejected'; failureCode: FailureCode };

@Injectable()
export class WageringService {
  constructor(
    private readonly orm: MikroORM,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly outbox: OutboxRepository,
    private readonly logger: AppLogger,
    private readonly metrics: AppMetrics,
  ) {}

  async submit(command: SubmitCommand): Promise<SubmitResult> {
    const startedAt = process.hrtime.bigint();
    const payloadHash = computePayloadHash(command);

    const replay = await this.tryReplay(command.idempotencyKey, payloadHash);
    if (replay) {
      this.metrics.replays.inc();
      return replay;
    }

    const result = await this.runWithRetry(command, payloadHash);

    this.metrics.duration.observe({ kind: command.kind }, Number(process.hrtime.bigint() - startedAt) / 1_000_000_000);
    this.metrics.transactions.inc({
      kind: command.kind,
      status: result.status,
      failureCode: result.failureCode ?? 'none',
    });

    return result;
  }

  private async tryReplay(idempotencyKey: string, payloadHash: string): Promise<SubmitResult | null> {
    const em = this.orm.em.fork() as EntityManager;
    const existing = await this.transactions.findByIdempotencyKey(em, idempotencyKey);

    if (!existing) {
      return null;
    }

    if (!existing.matchesPayload(payloadHash)) {
      this.metrics.conflicts.inc();
      throw new IdempotencyConflictError(idempotencyKey);
    }

    return {
      transactionId: existing.id,
      status: existing.status,
      balance: existing.observedBalance?.toJSON(),
      failureCode: existing.failureCode,
      idempotentReplay: true,
    };
  }

  private async runWithRetry(command: SubmitCommand, payloadHash: string): Promise<SubmitResult> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const em = this.orm.em.fork() as EntityManager;
        return await em.transactional(async (transactional) =>
          this.process(transactional as EntityManager, command, payloadHash),
        );
      } catch (error) {
        lastError = error;

        const retriable =
          isLockConflict(error) ||
          isUniqueViolation(error, 'wager_transactions_idempotency_key_unique') ||
          isUniqueViolation(error, 'wager_transactions_provider_external_unique') ||
          isUniqueViolation(error, 'wager_transactions_single_reversal_per_kind');

        if (!retriable || attempt === MAX_ATTEMPTS) {
          break;
        }

        this.metrics.lockRetries.inc();
        await sleep(10 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 15));
      }
    }

    if (isTransientDatabaseError(lastError) || isLockConflict(lastError)) {
      throw new TransientFailureError('database was unable to complete the wager transaction');
    }

    throw lastError;
  }

  private async process(em: EntityManager, command: SubmitCommand, payloadHash: string): Promise<SubmitResult> {
    await this.wallets.setLockTimeout(em, LOCK_TIMEOUT_MS);

    const wallet = await this.wallets.lockById(em, command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    const existing = await this.transactions.findByIdempotencyKey(em, command.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) {
        this.metrics.conflicts.inc();
        throw new IdempotencyConflictError(command.idempotencyKey);
      }
      return {
        transactionId: existing.id,
        status: existing.status,
        balance: existing.observedBalance?.toJSON(),
        failureCode: existing.failureCode,
        idempotentReplay: true,
      };
    }

    const now = new Date();
    const transaction = WagerTransaction.create({
      id: uuidv7(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    return this.decide(em, transaction, wallet, now);
  }

  private async decide(
    em: EntityManager,
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): Promise<SubmitResult> {
    if (transaction.playerId !== wallet.playerId) {
      return this.rejectWith(em, transaction, wallet, FailureCode.WalletPlayerMismatch, now);
    }

    if (!transaction.money.hasSameCurrency(wallet.balance)) {
      return this.rejectWith(em, transaction, wallet, FailureCode.CurrencyMismatch, now);
    }

    let reference: WagerTransaction | undefined;

    if (transaction.requiresReference()) {
      const outcome = await this.resolveReference(em, transaction);
      if (outcome.outcome === 'rejected') {
        return this.rejectWith(em, transaction, wallet, outcome.failureCode, now);
      }
      reference = outcome.reference;
    }

    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, now, wallet.balance);
      await this.transactions.insert(em, transaction);
      await this.outbox.addAll(em, [this.processedEvent(transaction, wallet, now)]);
      this.logSettled(transaction);
      return this.resultOf(transaction, wallet);
    }

    const direction = transaction.ledgerDirectionFor(reference);

    if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
      const failureCode =
        transaction.kind === WagerTransactionKind.Bet
          ? FailureCode.InsufficientFunds
          : FailureCode.ReversalWouldOverdrawWallet;
      return this.rejectWith(em, transaction, wallet, failureCode, now);
    }

    const entry = wallet.applyMovement(direction, {
      entryId: uuidv7(),
      transactionId: transaction.id,
      money: transaction.money,
      at: now,
    });

    transaction.markProcessed(reference?.id, now, wallet.balance);

    await this.transactions.insert(em, transaction);
    await this.wallets.saveBalance(em, wallet);
    await this.wallets.appendLedgerEntry(em, entry);
    await this.outbox.addAll(em, [
      this.processedEvent(transaction, wallet, now),
      this.balanceChangedEvent(wallet, entry, now),
    ]);

    this.logSettled(transaction);
    return this.resultOf(transaction, wallet);
  }

  private async resolveReference(em: EntityManager, transaction: WagerTransaction): Promise<ReferenceOutcome> {
    const referenceExternalId = transaction.referenceExternalTransactionId;
    if (!referenceExternalId) {
      return { outcome: 'rejected', failureCode: FailureCode.ReferenceNotFound };
    }

    const reference = await this.transactions.findByProviderAndExternalId(
      em,
      transaction.providerId,
      referenceExternalId,
    );

    if (!reference) {
      return { outcome: 'rejected', failureCode: FailureCode.ReferenceNotFound };
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      return { outcome: 'rejected', failureCode: FailureCode.ReferenceNotProcessed };
    }

    const allowedKinds = REVERSIBLE_BY.get(transaction.kind);
    if (!allowedKinds || !allowedKinds.has(reference.kind)) {
      return { outcome: 'rejected', failureCode: FailureCode.ReferenceKindNotReversible };
    }

    const sameScope =
      reference.playerId === transaction.playerId &&
      reference.walletId === transaction.walletId &&
      reference.roundId === transaction.roundId &&
      reference.money.currency === transaction.money.currency;

    if (!sameScope) {
      return { outcome: 'rejected', failureCode: FailureCode.ReferenceScopeMismatch };
    }

    if (!reference.money.equals(transaction.money)) {
      return { outcome: 'rejected', failureCode: FailureCode.ReversalAmountMismatch };
    }

    const alreadyReversed = await this.transactions.hasProcessedReversal(
      em,
      transaction.providerId,
      referenceExternalId,
      transaction.kind,
    );

    if (alreadyReversed) {
      return { outcome: 'rejected', failureCode: FailureCode.ReferenceAlreadyReversed };
    }

    return { outcome: 'resolved', reference };
  }

  private async rejectWith(
    em: EntityManager,
    transaction: WagerTransaction,
    wallet: Wallet,
    failureCode: FailureCode,
    now: Date,
  ): Promise<SubmitResult> {
    transaction.reject(failureCode, now, wallet.balance);
    await this.transactions.insert(em, transaction);
    await this.outbox.addAll(em, [this.rejectedEvent(transaction, now)]);
    this.logSettled(transaction);
    return this.resultOf(transaction, wallet);
  }

  private processedEvent(transaction: WagerTransaction, wallet: Wallet, now: Date): OutboxRecord {
    return transactionProcessed(
      transaction.id,
      {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        playerId: transaction.playerId,
        walletId: transaction.walletId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        balanceAfter: wallet.balance.toJSON(),
        referenceTransactionId: transaction.referenceTransactionId,
      },
      { eventId: uuidv7(), correlationId: transaction.id, causationId: transaction.id, occurredAt: now },
    );
  }

  private rejectedEvent(transaction: WagerTransaction, now: Date): OutboxRecord {
    return transactionRejected(
      transaction.id,
      {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        playerId: transaction.playerId,
        walletId: transaction.walletId,
        roundId: transaction.roundId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        failureCode: transaction.failureCode ?? FailureCode.InsufficientFunds,
      },
      { eventId: uuidv7(), correlationId: transaction.id, causationId: transaction.id, occurredAt: now },
    );
  }

  private balanceChangedEvent(wallet: Wallet, entry: WalletLedgerEntry, now: Date): OutboxRecord {
    return walletBalanceChanged(
      wallet.id,
      {
        walletId: wallet.id,
        playerId: wallet.playerId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
      { eventId: uuidv7(), correlationId: entry.transactionId, causationId: entry.transactionId, occurredAt: now },
    );
  }

  private resultOf(transaction: WagerTransaction, wallet: Wallet): SubmitResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      failureCode: transaction.failureCode,
      idempotentReplay: false,
    };
  }

  private logSettled(transaction: WagerTransaction): void {
    this.logger.info('wager transaction settled', {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      kind: transaction.kind,
      status: transaction.status,
      failureCode: transaction.failureCode,
    });
  }

  async getById(transactionId: string): Promise<TransactionView | null> {
    const em = this.orm.em.fork() as EntityManager;
    const transaction = await this.transactions.findById(em, transactionId);
    return transaction ? toView(transaction) : null;
  }

  async getByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView | null> {
    const em = this.orm.em.fork() as EntityManager;
    const transaction = await this.transactions.findByProviderAndExternalId(em, providerId, externalTransactionId);
    return transaction ? toView(transaction) : null;
  }
}

function toView(transaction: WagerTransaction): TransactionView {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    balanceAfter: transaction.observedBalance?.toJSON(),
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString(),
  };
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
