import '../support/test-env';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import ormConfig from '../../src/mikro-orm.config';
import { isDatabaseReachable, query } from '../support/test-app';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('garantias no schema do banco', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(ormConfig);
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  async function insertWallet(amount: string, currency = 'BRL'): Promise<{ walletId: string; playerId: string }> {
    const walletId = uuidv7();
    const playerId = uuidv7();

    await query(
      orm,
      `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values (?, ?, ?, ?, 1, now(), now())`,
      [walletId, playerId, currency, amount],
    );

    return { walletId, playerId };
  }

  async function insertTransaction(
    walletId: string,
    playerId: string,
    overrides: Partial<{
      externalTransactionId: string;
      idempotencyKey: string;
      kind: string;
      status: string;
      amount: string;
      reference: string | null;
      failureCode: string | null;
      processedAt: string | null;
    }> = {},
  ): Promise<string> {
    const id = uuidv7();
    const externalTransactionId = overrides.externalTransactionId ?? uuidv7();
    const status = overrides.status ?? 'PROCESSED';

    await query(
      orm,
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
          round_id, game_id, kind, currency, amount, reference_external_transaction_id, status,
          failure_code, created_at, processed_at)
       values (?, 'provider-a', ?, ?, ?, ?, ?, 'round-1', 'game-1', ?, 'BRL', ?, ?, ?, ?, now(), ?)`,
      [
        id,
        externalTransactionId,
        overrides.idempotencyKey ?? `provider-a:${externalTransactionId}`,
        'a'.repeat(64),
        walletId,
        playerId,
        overrides.kind ?? 'BET',
        overrides.amount ?? '25.00',
        overrides.reference ?? null,
        status,
        overrides.failureCode ?? null,
        overrides.processedAt === undefined ? new Date().toISOString() : overrides.processedAt,
      ],
    );

    return id;
  }

  async function insertLedgerEntry(
    walletId: string,
    transactionId: string,
    direction: string,
    amount: string,
    before: string,
    after: string,
  ): Promise<string> {
    const id = uuidv7();
    await query(
      orm,
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, currency, amount,
          balance_before_amount, balance_after_amount, created_at)
       values (?, ?, ?, ?, 'BRL', ?, ?, ?, now())`,
      [id, walletId, transactionId, direction, amount, before, after],
    );
    return id;
  }

  test('todas as tabelas da migration existem', async () => {
    const rows = await query<{ table_name: string }>(
      orm,
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const tables = rows.map((row) => row.table_name);

    expect(tables).toContain('wallets');
    expect(tables).toContain('wager_transactions');
    expect(tables).toContain('wallet_ledger_entries');
    expect(tables).toContain('outbox_messages');
    expect(tables).toContain('reconciliation_checks');
    expect(tables).toContain('mikro_orm_migrations');
  });

  test('toda coluna de dinheiro e numeric com escala 2, nunca ponto flutuante', async () => {
    const rows = await query<{ column_name: string; data_type: string; numeric_scale: number }>(
      orm,
      `select column_name, data_type, numeric_scale
       from information_schema.columns
       where table_schema = 'public'
         and (column_name like '%amount%' or column_name like '%balance%')`,
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data_type).toBe('numeric');
      expect(row.numeric_scale).toBe(2);
    }
  });

  test('o saldo nunca pode ser gravado negativo', async () => {
    const { walletId } = await insertWallet('100.00');

    await expect(query(orm, 'update wallets set balance_amount = -1 where id = ?', [walletId])).rejects.toThrow(
      /wallets_balance_non_negative/,
    );
  });

  test('um jogador tem no maximo uma wallet por moeda', async () => {
    const { playerId } = await insertWallet('100.00', 'BRL');

    await expect(
      query(
        orm,
        `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
         values (?, ?, 'BRL', '0.00', 1, now(), now())`,
        [uuidv7(), playerId],
      ),
    ).rejects.toThrow(/wallets_player_currency_unique/);

    await query(
      orm,
      `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values (?, ?, 'USD', '0.00', 1, now(), now())`,
      [uuidv7(), playerId],
    );
  });

  test('uma idempotency key so pode ser usada uma vez', async () => {
    const { walletId, playerId } = await insertWallet('100.00');
    const key = `provider-a:${uuidv7()}`;

    await insertTransaction(walletId, playerId, { idempotencyKey: key });

    await expect(insertTransaction(walletId, playerId, { idempotencyKey: key })).rejects.toThrow(
      /wager_transactions_idempotency_key_unique/,
    );
  });

  test('o provedor nao pode reusar um id externo', async () => {
    const { walletId, playerId } = await insertWallet('100.00');
    const externalTransactionId = uuidv7();

    await insertTransaction(walletId, playerId, { externalTransactionId });

    await expect(
      insertTransaction(walletId, playerId, { externalTransactionId, idempotencyKey: uuidv7() }),
    ).rejects.toThrow(/wager_transactions_provider_external_unique/);
  });

  test('refund e rollback nao podem ser gravados sem referencia', async () => {
    const { walletId, playerId } = await insertWallet('100.00');

    await expect(insertTransaction(walletId, playerId, { kind: 'REFUND', reference: null })).rejects.toThrow(
      /wager_transactions_reference_required/,
    );
    await expect(insertTransaction(walletId, playerId, { kind: 'ROLLBACK', reference: null })).rejects.toThrow(
      /wager_transactions_reference_required/,
    );
  });

  test('a mesma referencia nao pode ser revertida duas vezes pelo mesmo tipo', async () => {
    const { walletId, playerId } = await insertWallet('500.00');
    const betExternalId = uuidv7();

    await insertTransaction(walletId, playerId, { externalTransactionId: betExternalId, kind: 'BET' });
    await insertTransaction(walletId, playerId, { kind: 'REFUND', reference: betExternalId, status: 'PROCESSED' });

    await expect(
      insertTransaction(walletId, playerId, { kind: 'REFUND', reference: betExternalId, status: 'PROCESSED' }),
    ).rejects.toThrow(/wager_transactions_single_reversal_per_kind/);

    await insertTransaction(walletId, playerId, { kind: 'ROLLBACK', reference: betExternalId, status: 'PROCESSED' });
  });

  test('uma reversao rejeitada nao consome a vaga da reversao', async () => {
    const { walletId, playerId } = await insertWallet('500.00');
    const betExternalId = uuidv7();

    await insertTransaction(walletId, playerId, { externalTransactionId: betExternalId, kind: 'BET' });
    await insertTransaction(walletId, playerId, {
      kind: 'REFUND',
      reference: betExternalId,
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    await insertTransaction(walletId, playerId, { kind: 'REFUND', reference: betExternalId, status: 'PROCESSED' });
  });

  test('o failure code tem que ser coerente com o status', async () => {
    const { walletId, playerId } = await insertWallet('100.00');

    await expect(insertTransaction(walletId, playerId, { status: 'REJECTED', failureCode: null })).rejects.toThrow(
      /wager_transactions_failure_code_matches_status/,
    );

    await expect(
      insertTransaction(walletId, playerId, { status: 'PROCESSED', failureCode: 'INSUFFICIENT_FUNDS' }),
    ).rejects.toThrow(/wager_transactions_failure_code_matches_status/);

    await expect(insertTransaction(walletId, playerId, { status: 'PROCESSED', processedAt: null })).rejects.toThrow(
      /wager_transactions_terminal_has_processed_at/,
    );
  });

  test('uma transacao nao pode referenciar a si mesma', async () => {
    const { walletId, playerId } = await insertWallet('100.00');
    const externalTransactionId = uuidv7();

    await expect(
      insertTransaction(walletId, playerId, {
        externalTransactionId,
        kind: 'ROLLBACK',
        reference: externalTransactionId,
      }),
    ).rejects.toThrow(/wager_transactions_no_self_reference/);
  });

  test('o ledger recusa um lancamento cuja aritmetica nao fecha', async () => {
    const { walletId, playerId } = await insertWallet('100.00');
    const transactionId = await insertTransaction(walletId, playerId);

    await expect(insertLedgerEntry(walletId, transactionId, 'DEBIT', '25.00', '100.00', '80.00')).rejects.toThrow(
      /wallet_ledger_entries_arithmetic/,
    );
    await expect(insertLedgerEntry(walletId, transactionId, 'CREDIT', '25.00', '100.00', '120.00')).rejects.toThrow(
      /wallet_ledger_entries_arithmetic/,
    );
  });

  test('o ledger recusa valor zero e saldo resultante negativo', async () => {
    const { walletId, playerId } = await insertWallet('100.00');
    const transactionId = await insertTransaction(walletId, playerId);

    await expect(insertLedgerEntry(walletId, transactionId, 'CREDIT', '0.00', '100.00', '100.00')).rejects.toThrow(
      /wallet_ledger_entries_amount_positive/,
    );
    await expect(insertLedgerEntry(walletId, transactionId, 'DEBIT', '150.00', '100.00', '-50.00')).rejects.toThrow(
      /wallet_ledger_entries_balance_after_non_negative/,
    );
  });

  test('uma transacao produz no maximo um lancamento por wallet', async () => {
    const { walletId, playerId } = await insertWallet('100.00');
    const transactionId = await insertTransaction(walletId, playerId);

    await insertLedgerEntry(walletId, transactionId, 'DEBIT', '25.00', '100.00', '75.00');

    await expect(insertLedgerEntry(walletId, transactionId, 'DEBIT', '25.00', '75.00', '50.00')).rejects.toThrow(
      /wallet_ledger_entries_one_per_wallet_transaction/,
    );
  });

  test('lancamentos do ledger nunca podem ser alterados, apagados ou truncados', async () => {
    const { walletId, playerId } = await insertWallet('100.00');
    const transactionId = await insertTransaction(walletId, playerId);
    const entryId = await insertLedgerEntry(walletId, transactionId, 'DEBIT', '25.00', '100.00', '75.00');

    await expect(query(orm, 'update wallet_ledger_entries set amount = 1 where id = ?', [entryId])).rejects.toThrow(
      /append-only/,
    );
    await expect(query(orm, 'delete from wallet_ledger_entries where id = ?', [entryId])).rejects.toThrow(
      /append-only/,
    );
    await expect(query(orm, 'truncate table wallet_ledger_entries')).rejects.toThrow(/append-only/);

    const rows = await query<{ amount: string }>(orm, 'select amount from wallet_ledger_entries where id = ?', [
      entryId,
    ]);
    expect(rows[0]?.amount).toBe('25.00');
  });

  test('a migration esta aplicada e nao sobrou nada pendente', async () => {
    const migrator = orm.getMigrator();
    expect((await migrator.getExecutedMigrations()).length).toBeGreaterThan(0);
    expect((await migrator.getPendingMigrations()).length).toBe(0);
  });
});
