import './test-env';
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import { MikroORM as PostgresMikroORM } from '@mikro-orm/postgresql';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { ErrorFilter } from '../../src/shared/error.filter';
import { AppLogger } from '../../src/shared/logger';

export interface TestApp {
  app: INestApplication;
  orm: MikroORM;
  baseUrl: string;
  stop: () => Promise<void>;
}

export async function startTestApp(): Promise<TestApp> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ErrorFilter(app.get(AppLogger)));
  await app.listen(0, '127.0.0.1');

  const url = await app.getUrl();
  const baseUrl = url.replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');
  const orm = app.get(MikroORM);

  return {
    app,
    orm,
    baseUrl,
    stop: async () => {
      await app.close();
      await orm.close(true);
    },
  };
}

export async function isDatabaseReachable(): Promise<boolean> {
  const { default: config } = await import('../../src/mikro-orm.config');
  try {
    const orm = await PostgresMikroORM.init({ ...config, connect: true });
    await orm.em.getConnection().execute('select 1');
    await orm.close(true);
    return true;
  } catch {
    return false;
  }
}

export async function query<T>(orm: MikroORM, sql: string, parameters: unknown[] = []): Promise<T[]> {
  return orm.em.getConnection().execute<T[]>(sql, parameters);
}

export async function countRows(orm: MikroORM, table: string, where: string, parameters: unknown[]): Promise<number> {
  const rows = await query<{ total: string }>(
    orm,
    `select count(*)::text as total from ${table} where ${where}`,
    parameters,
  );
  return Number.parseInt(rows[0]?.total ?? '0', 10);
}

export async function ledgerSum(orm: MikroORM, walletId: string): Promise<string> {
  const rows = await query<{ total: string }>(
    orm,
    `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20,2)::text as total
     from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  );
  return rows[0]?.total ?? '0.00';
}

export async function storedBalance(orm: MikroORM, walletId: string): Promise<string> {
  const rows = await query<{ balance_amount: string }>(orm, 'select balance_amount from wallets where id = ?', [
    walletId,
  ]);
  return rows[0]?.balance_amount ?? 'missing';
}

export async function assertWalletMatchesLedger(orm: MikroORM, walletId: string): Promise<void> {
  const stored = await storedBalance(orm, walletId);
  const replayed = await ledgerSum(orm, walletId);

  if (stored !== replayed) {
    throw new Error(`wallet ${walletId} stored balance ${stored} does not match ledger sum ${replayed}`);
  }
}

export interface HttpResult<T> {
  status: number;
  body: T;
}

export async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

export async function getJson<T>(baseUrl: string, path: string): Promise<HttpResult<T>> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export interface SubmitResponse {
  transactionId: string;
  status: string;
  balance?: { amount: string; currency: string };
  failureCode?: string;
  idempotentReplay: boolean;
}

export async function createWallet(baseUrl: string, amount: string, currency = 'BRL'): Promise<WalletResponse> {
  const result = await postJson<WalletResponse>(baseUrl, '/wallets', {
    playerId: uuidv7(),
    initialBalance: { amount, currency },
  });

  if (result.status !== 201) {
    throw new Error(`could not create wallet: ${result.status} ${JSON.stringify(result.body)}`);
  }

  return result.body;
}

export interface SubmitOptions {
  providerId?: string;
  externalTransactionId?: string;
  roundId?: string;
  gameId?: string;
  kind: string;
  amount: string;
  currency?: string;
  referenceExternalTransactionId?: string;
  idempotencyKey?: string;
}

export async function submit(
  baseUrl: string,
  wallet: WalletResponse,
  options: SubmitOptions,
): Promise<HttpResult<SubmitResponse>> {
  const providerId = options.providerId ?? 'provider-a';
  const externalTransactionId = options.externalTransactionId ?? uuidv7();

  return postJson<SubmitResponse>(
    baseUrl,
    '/wagering/transactions',
    {
      providerId,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: options.roundId ?? 'round-987',
      gameId: options.gameId ?? 'fortune-chimp',
      kind: options.kind,
      money: { amount: options.amount, currency: options.currency ?? 'BRL' },
      ...(options.referenceExternalTransactionId
        ? { referenceExternalTransactionId: options.referenceExternalTransactionId }
        : {}),
    },
    { 'idempotency-key': options.idempotencyKey ?? `${providerId}:${externalTransactionId}` },
  );
}
