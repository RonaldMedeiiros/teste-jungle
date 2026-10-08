import '../support/test-env';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import {
  TestApp,
  assertWalletMatchesLedger,
  countRows,
  createWallet,
  isDatabaseReachable,
  ledgerSum,
  query,
  startTestApp,
  submit,
} from '../support/test-app';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('uma transacao sql para transacao, saldo, ledger e outbox', () => {
  let app: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    app = await startTestApp();
    baseUrl = app.baseUrl;
  });

  afterAll(async () => {
    await app?.stop();
  });

  afterEach(async () => {
    await query(app.orm, 'drop trigger if exists test_outbox_explode on outbox_messages');
    await query(app.orm, 'drop function if exists test_explode_on_outbox()');
  });

  test('uma aposta processada comita as quatro escritas juntas', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const result = await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00' });
    const transactionId = result.body.transactionId;

    expect(await countRows(app.orm, 'wager_transactions', 'id = ?', [transactionId])).toBe(1);
    expect(await countRows(app.orm, 'wallet_ledger_entries', 'transaction_id = ?', [transactionId])).toBe(1);
    expect(await countRows(app.orm, 'outbox_messages', 'aggregate_id = ?', [transactionId])).toBe(1);
    expect(await countRows(app.orm, 'outbox_messages', 'aggregate_id = ?', [wallet.id])).toBe(2);

    const stored = await query<{ balance_amount: string; version: number }>(
      app.orm,
      'select balance_amount, version from wallets where id = ?',
      [wallet.id],
    );
    expect(stored[0]?.balance_amount).toBe('75.00');
    expect(stored[0]?.version).toBe(2);

    await assertWalletMatchesLedger(app.orm, wallet.id);
  });

  test('uma falha ao escrever o outbox desfaz o dinheiro tambem', async () => {
    const wallet = await createWallet(baseUrl, '100.00');

    await query(
      app.orm,
      `create or replace function test_explode_on_outbox() returns trigger as $$
       begin
         if new.payload->'data'->>'gameId' = 'explode' then
           raise exception 'simulated outbox failure';
         end if;
         return new;
       end;
       $$ language plpgsql;`,
    );

    await query(
      app.orm,
      `create trigger test_outbox_explode before insert on outbox_messages
       for each row execute function test_explode_on_outbox()`,
    );

    const externalTransactionId = uuidv7();
    const result = await submit(baseUrl, wallet, {
      kind: 'BET',
      amount: '25.00',
      gameId: 'explode',
      externalTransactionId,
    });

    expect(result.status).toBeGreaterThanOrEqual(500);

    expect(
      await countRows(app.orm, 'wager_transactions', 'external_transaction_id = ?', [externalTransactionId]),
    ).toBe(0);
    expect(await ledgerSum(app.orm, wallet.id)).toBe('100.00');

    const stored = await query<{ balance_amount: string; version: number }>(
      app.orm,
      'select balance_amount, version from wallets where id = ?',
      [wallet.id],
    );
    expect(stored[0]?.balance_amount).toBe('100.00');
    expect(stored[0]?.version).toBe(1);

    await assertWalletMatchesLedger(app.orm, wallet.id);
  });

  test('uma aposta rejeitada ainda comita a transacao e o evento de rejeicao', async () => {
    const wallet = await createWallet(baseUrl, '10.00');
    const result = await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00' });
    const transactionId = result.body.transactionId;

    expect(await countRows(app.orm, 'wager_transactions', "id = ? and status = 'REJECTED'", [transactionId])).toBe(1);
    expect(await countRows(app.orm, 'wallet_ledger_entries', 'transaction_id = ?', [transactionId])).toBe(0);

    const events = await query<{ event_type: string }>(
      app.orm,
      'select event_type from outbox_messages where aggregate_id = ?',
      [transactionId],
    );
    expect(events.map((row) => row.event_type)).toEqual(['WagerTransactionRejected']);
  });

  test('os eventos ficam pendentes porque nao existe publisher neste projeto', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const result = await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00' });

    const pending = await countRows(app.orm, 'outbox_messages', 'aggregate_id = ? and published_at is null', [
      result.body.transactionId,
    ]);

    expect(pending).toBe(1);
  });
});
