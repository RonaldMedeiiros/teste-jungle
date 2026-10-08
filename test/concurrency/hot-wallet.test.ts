import '../support/test-env';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import {
  SubmitResponse,
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

describe.skipIf(!reachable)('uma wallet sob pressao concorrente', () => {
  let app: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    app = await startTestApp();
    baseUrl = app.baseUrl;
  });

  afterAll(async () => {
    await app?.stop();
  });

  test('a mesma aposta enviada 50 vezes em paralelo produz um unico debito', async () => {
    const wallet = await createWallet(baseUrl, '1000.00');
    const externalTransactionId = uuidv7();

    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        submit(baseUrl, wallet, { kind: 'BET', amount: '25.00', externalTransactionId }),
      ),
    );

    expect(responses.filter((response) => response.status === 200).length).toBe(50);

    const transactionIds = new Set(responses.map((response) => response.body.transactionId));
    expect(transactionIds.size).toBe(1);

    expect(responses.filter((response) => response.body.idempotentReplay === false).length).toBe(1);

    const transactionId = [...transactionIds][0] as string;
    expect(await countRows(app.orm, 'wallet_ledger_entries', 'transaction_id = ?', [transactionId])).toBe(1);
    expect(await ledgerSum(app.orm, wallet.id)).toBe('975.00');
    await assertWalletMatchesLedger(app.orm, wallet.id);
  }, 60000);

  test('duas apostas de 80.00 ao mesmo tempo contra 100.00 de saldo', async () => {
    const wallet = await createWallet(baseUrl, '100.00');

    const outcomes = (await Promise.all([
      submit(baseUrl, wallet, { kind: 'BET', amount: '80.00', externalTransactionId: uuidv7() }),
      submit(baseUrl, wallet, { kind: 'BET', amount: '80.00', externalTransactionId: uuidv7() }),
    ])) as Array<{ status: number; body: SubmitResponse }>;

    const processed = outcomes.filter((outcome) => outcome.body.status === 'PROCESSED');
    const rejected = outcomes.filter((outcome) => outcome.body.status === 'REJECTED');

    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejected[0]?.status).toBe(422);

    const debits = await countRows(app.orm, 'wallet_ledger_entries', "wallet_id = ? and direction = 'DEBIT'", [
      wallet.id,
    ]);
    expect(debits).toBe(1);

    const stored = await query<{ balance_amount: string }>(app.orm, 'select balance_amount from wallets where id = ?', [
      wallet.id,
    ]);
    expect(stored[0]?.balance_amount).toBe('20.00');
    expect(await ledgerSum(app.orm, wallet.id)).toBe('20.00');
    await assertWalletMatchesLedger(app.orm, wallet.id);
  }, 60000);

  test('trinta apostas concorrentes esvaziam a wallet sem nunca ficar negativa', async () => {
    const wallet = await createWallet(baseUrl, '100.00');

    const responses = await Promise.all(
      Array.from({ length: 30 }, () =>
        submit(baseUrl, wallet, { kind: 'BET', amount: '10.00', externalTransactionId: uuidv7() }),
      ),
    );

    const processed = responses.filter((response) => response.body.status === 'PROCESSED');
    const rejected = responses.filter((response) => response.body.status === 'REJECTED');

    expect(processed.length).toBe(10);
    expect(rejected.length).toBe(20);
    for (const response of rejected) {
      expect(response.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    }

    const stored = await query<{ balance_amount: string }>(app.orm, 'select balance_amount from wallets where id = ?', [
      wallet.id,
    ]);
    expect(stored[0]?.balance_amount).toBe('0.00');
    expect(await ledgerSum(app.orm, wallet.id)).toBe('0.00');
    expect(
      await countRows(app.orm, 'wallet_ledger_entries', "wallet_id = ? and direction = 'DEBIT'", [wallet.id]),
    ).toBe(10);

    await assertWalletMatchesLedger(app.orm, wallet.id);
  }, 90000);

  test('um reembolso correndo contra si mesmo e aplicado uma unica vez', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const betId = uuidv7();

    await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00', externalTransactionId: betId });

    const refunds = await Promise.all(
      Array.from({ length: 8 }, () =>
        submit(baseUrl, wallet, {
          kind: 'REFUND',
          amount: '25.00',
          externalTransactionId: uuidv7(),
          referenceExternalTransactionId: betId,
        }),
      ),
    );

    expect(refunds.filter((refund) => refund.body.status === 'PROCESSED').length).toBe(1);
    expect(refunds.filter((refund) => refund.body.failureCode === 'REFERENCE_ALREADY_REVERSED').length).toBe(7);

    expect(await ledgerSum(app.orm, wallet.id)).toBe('100.00');
    await assertWalletMatchesLedger(app.orm, wallet.id);
  }, 60000);

  test('wallets diferentes sao debitadas em paralelo sem se atrapalhar', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(baseUrl, '100.00')));

    await Promise.all(
      wallets.map((wallet) =>
        Promise.all([
          submit(baseUrl, wallet, { kind: 'BET', amount: '25.00', externalTransactionId: uuidv7() }),
          submit(baseUrl, wallet, { kind: 'WIN', amount: '5.00', externalTransactionId: uuidv7() }),
        ]),
      ),
    );

    for (const wallet of wallets) {
      const stored = await query<{ balance_amount: string }>(
        app.orm,
        'select balance_amount from wallets where id = ?',
        [wallet.id],
      );
      expect(stored[0]?.balance_amount).toBe('80.00');
      await assertWalletMatchesLedger(app.orm, wallet.id);
    }
  }, 90000);

  test('o saldo continua consistente depois de reiniciar o servico', async () => {
    const wallet = await createWallet(baseUrl, '500.00');

    await Promise.all(
      Array.from({ length: 10 }, () =>
        submit(baseUrl, wallet, { kind: 'BET', amount: '10.00', externalTransactionId: uuidv7() }),
      ),
    );

    const before = await query<{ balance_amount: string }>(
      app.orm,
      'select balance_amount from wallets where id = ?',
      [wallet.id],
    );

    const restarted = await startTestApp();

    try {
      const after = await query<{ balance_amount: string }>(
        restarted.orm,
        'select balance_amount from wallets where id = ?',
        [wallet.id],
      );

      expect(after[0]?.balance_amount).toBe(before[0]?.balance_amount);
      expect(after[0]?.balance_amount).toBe('400.00');
      expect(await ledgerSum(restarted.orm, wallet.id)).toBe('400.00');
      await assertWalletMatchesLedger(restarted.orm, wallet.id);

      const next = await submit(restarted.baseUrl, wallet, {
        kind: 'BET',
        amount: '10.00',
        externalTransactionId: uuidv7(),
      });
      expect(next.status).toBe(200);
      expect(await ledgerSum(restarted.orm, wallet.id)).toBe('390.00');
    } finally {
      await restarted.stop();
    }
  }, 120000);
});
