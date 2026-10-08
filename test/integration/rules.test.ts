import '../support/test-env';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import {
  TestApp,
  assertWalletMatchesLedger,
  countRows,
  createWallet,
  getJson,
  isDatabaseReachable,
  ledgerSum,
  postJson,
  query,
  startTestApp,
  submit,
} from '../support/test-app';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('regras de negocio pela api', () => {
  let app: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    app = await startTestApp();
    baseUrl = app.baseUrl;
  });

  afterAll(async () => {
    await app?.stop();
  });

  test('abrir wallet cria a transacao OPENING e o lancamento de credito', async () => {
    const wallet = await createWallet(baseUrl, '1000.00');

    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);

    const openings = await countRows(
      app.orm,
      'wager_transactions',
      "wallet_id = ? and kind = 'OPENING' and status = 'PROCESSED'",
      [wallet.id],
    );
    expect(openings).toBe(1);
    expect(await ledgerSum(app.orm, wallet.id)).toBe('1000.00');
    await assertWalletMatchesLedger(app.orm, wallet.id);
  });

  test('wallet aberta com saldo zero nao gera lancamento', async () => {
    const wallet = await createWallet(baseUrl, '0.00');
    expect(await ledgerSum(app.orm, wallet.id)).toBe('0.00');
    expect(await countRows(app.orm, 'wallet_ledger_entries', 'wallet_id = ?', [wallet.id])).toBe(0);
  });

  test('wallet duplicada para o mesmo jogador e moeda e conflito', async () => {
    const wallet = await createWallet(baseUrl, '100.00');

    const duplicate = await postJson(baseUrl, '/wallets', {
      playerId: wallet.playerId,
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });

    expect(duplicate.status).toBe(409);
    expect((duplicate.body as { error: string }).error).toBe('WALLET_ALREADY_EXISTS');
  });

  test('uma aposta debita e escreve exatamente um lancamento de debito', async () => {
    const wallet = await createWallet(baseUrl, '1000.00');
    const result = await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00' });

    expect(result.status).toBe(200);
    expect(result.body.status).toBe('PROCESSED');
    expect(result.body.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(result.body.idempotentReplay).toBe(false);

    const debits = await countRows(app.orm, 'wallet_ledger_entries', "wallet_id = ? and direction = 'DEBIT'", [
      wallet.id,
    ]);
    expect(debits).toBe(1);
    await assertWalletMatchesLedger(app.orm, wallet.id);
  });

  test('aposta sem saldo e rejeitada e nao move nada', async () => {
    const wallet = await createWallet(baseUrl, '10.00');
    const result = await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00' });

    expect(result.status).toBe(422);
    expect(result.body.status).toBe('REJECTED');
    expect(result.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await ledgerSum(app.orm, wallet.id)).toBe('10.00');
    await assertWalletMatchesLedger(app.orm, wallet.id);
  });

  test('um ganho credita a wallet', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const result = await submit(baseUrl, wallet, { kind: 'WIN', amount: '40.00' });

    expect(result.body.balance).toEqual({ amount: '140.00', currency: 'BRL' });
    await assertWalletMatchesLedger(app.orm, wallet.id);
  });

  test('uma derrota e processada sem tocar no saldo nem no ledger', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const before = await countRows(app.orm, 'wallet_ledger_entries', 'wallet_id = ?', [wallet.id]);

    const result = await submit(baseUrl, wallet, { kind: 'LOSS', amount: '30.00' });

    expect(result.status).toBe(200);
    expect(result.body.status).toBe('PROCESSED');
    expect(result.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(await countRows(app.orm, 'wallet_ledger_entries', 'wallet_id = ?', [wallet.id])).toBe(before);

    const events = await query<{ event_type: string }>(
      app.orm,
      'select event_type from outbox_messages where aggregate_id = ?',
      [result.body.transactionId],
    );
    expect(events.map((row) => row.event_type)).toEqual(['WagerTransactionProcessed']);
  });

  test('um reembolso devolve a aposta uma unica vez', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const betId = uuidv7();

    await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00', externalTransactionId: betId });

    const refund = await submit(baseUrl, wallet, {
      kind: 'REFUND',
      amount: '25.00',
      referenceExternalTransactionId: betId,
    });

    expect(refund.status).toBe(200);
    expect(refund.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const second = await submit(baseUrl, wallet, {
      kind: 'REFUND',
      amount: '25.00',
      referenceExternalTransactionId: betId,
    });

    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await ledgerSum(app.orm, wallet.id)).toBe('100.00');
    await assertWalletMatchesLedger(app.orm, wallet.id);
  });

  test('um rollback inverte a direcao da referencia', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const winId = uuidv7();

    await submit(baseUrl, wallet, { kind: 'WIN', amount: '40.00', externalTransactionId: winId });

    const rollback = await submit(baseUrl, wallet, {
      kind: 'ROLLBACK',
      amount: '40.00',
      referenceExternalTransactionId: winId,
    });

    expect(rollback.status).toBe(200);
    expect(rollback.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const entries = await query<{ direction: string }>(
      app.orm,
      'select direction from wallet_ledger_entries where transaction_id = ?',
      [rollback.body.transactionId],
    );
    expect(entries).toEqual([{ direction: 'DEBIT' }]);
    await assertWalletMatchesLedger(app.orm, wallet.id);
  });

  test('um rollback que deixaria a wallet negativa tem failure code proprio', async () => {
    const wallet = await createWallet(baseUrl, '0.00');
    const winId = uuidv7();

    await submit(baseUrl, wallet, { kind: 'WIN', amount: '50.00', externalTransactionId: winId });
    await submit(baseUrl, wallet, { kind: 'BET', amount: '50.00' });

    const rollback = await submit(baseUrl, wallet, {
      kind: 'ROLLBACK',
      amount: '50.00',
      referenceExternalTransactionId: winId,
    });

    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REVERSAL_WOULD_OVERDRAW_WALLET');
    expect(rollback.body.failureCode).not.toBe('INSUFFICIENT_FUNDS');
    await assertWalletMatchesLedger(app.orm, wallet.id);
  });

  test('um reembolso so pode referenciar uma aposta', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const winId = uuidv7();

    await submit(baseUrl, wallet, { kind: 'WIN', amount: '10.00', externalTransactionId: winId });

    const refund = await submit(baseUrl, wallet, {
      kind: 'REFUND',
      amount: '10.00',
      referenceExternalTransactionId: winId,
    });

    expect(refund.status).toBe(422);
    expect(refund.body.failureCode).toBe('REFERENCE_KIND_NOT_REVERSIBLE');
  });

  test('o valor da reversao tem que ser igual ao da referencia', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const betId = uuidv7();

    await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00', externalTransactionId: betId });

    const refund = await submit(baseUrl, wallet, {
      kind: 'REFUND',
      amount: '10.00',
      referenceExternalTransactionId: betId,
    });

    expect(refund.status).toBe(422);
    expect(refund.body.failureCode).toBe('REVERSAL_AMOUNT_MISMATCH');
  });

  test('a reversao tem que ficar na mesma rodada', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const betId = uuidv7();

    await submit(baseUrl, wallet, {
      kind: 'BET',
      amount: '25.00',
      externalTransactionId: betId,
      roundId: 'round-aaa',
    });

    const refund = await submit(baseUrl, wallet, {
      kind: 'REFUND',
      amount: '25.00',
      roundId: 'round-bbb',
      referenceExternalTransactionId: betId,
    });

    expect(refund.status).toBe(422);
    expect(refund.body.failureCode).toBe('REFERENCE_SCOPE_MISMATCH');
  });

  test('uma referencia que nao existe e rejeitada com codigo proprio', async () => {
    const wallet = await createWallet(baseUrl, '100.00');

    const refund = await submit(baseUrl, wallet, {
      kind: 'REFUND',
      amount: '25.00',
      referenceExternalTransactionId: `nao-existe-${uuidv7()}`,
    });

    expect(refund.status).toBe(422);
    expect(refund.body.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(await ledgerSum(app.orm, wallet.id)).toBe('100.00');
  });

  test('moeda diferente da wallet e rejeitada', async () => {
    const wallet = await createWallet(baseUrl, '100.00', 'BRL');
    const result = await submit(baseUrl, wallet, { kind: 'BET', amount: '10.00', currency: 'USD' });

    expect(result.status).toBe(422);
    expect(result.body.failureCode).toBe('CURRENCY_MISMATCH');
    await assertWalletMatchesLedger(app.orm, wallet.id);
  });

  test('wallet inexistente retorna 404', async () => {
    const result = await postJson(
      baseUrl,
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId: uuidv7(),
        playerId: uuidv7(),
        walletId: uuidv7(),
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
      { 'idempotency-key': `provider-a:${uuidv7()}` },
    );

    expect(result.status).toBe(404);
    expect((result.body as { failureCode: string }).failureCode).toBe('WALLET_NOT_FOUND');
  });

  test('o tipo interno OPENING nao pode ser submetido', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const result = await submit(baseUrl, wallet, { kind: 'OPENING', amount: '10.00' });
    expect(result.status).toBe(400);
  });
});

describe.skipIf(!reachable)('idempotencia', () => {
  let app: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    app = await startTestApp();
    baseUrl = app.baseUrl;
  });

  afterAll(async () => {
    await app?.stop();
  });

  test('o header Idempotency-Key e obrigatorio', async () => {
    const wallet = await createWallet(baseUrl, '100.00');

    const result = await postJson(baseUrl, '/wagering/transactions', {
      providerId: 'provider-a',
      externalTransactionId: uuidv7(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    expect(result.status).toBe(400);
  });

  test('repetir a mesma requisicao devolve o resultado original e o saldo daquele momento', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const externalTransactionId = uuidv7();

    const first = await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00', externalTransactionId });
    await submit(baseUrl, wallet, { kind: 'BET', amount: '10.00' });

    const replay = await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00', externalTransactionId });

    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(replay.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    expect(await countRows(app.orm, 'wallet_ledger_entries', 'transaction_id = ?', [first.body.transactionId])).toBe(1);
    expect(await ledgerSum(app.orm, wallet.id)).toBe('65.00');
  });

  test('repetir uma transacao rejeitada devolve a mesma rejeicao', async () => {
    const wallet = await createWallet(baseUrl, '10.00');
    const externalTransactionId = uuidv7();

    const first = await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00', externalTransactionId });
    const replay = await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00', externalTransactionId });

    expect(first.status).toBe(422);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(replay.body.transactionId).toBe(first.body.transactionId);
  });

  test('a mesma key com payload diferente e conflito, nunca replay', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const idempotencyKey = `provider-a:${uuidv7()}`;
    const externalTransactionId = uuidv7();

    const first = await submit(baseUrl, wallet, {
      kind: 'BET',
      amount: '25.00',
      externalTransactionId,
      idempotencyKey,
    });
    expect(first.status).toBe(200);

    const conflict = await submit(baseUrl, wallet, {
      kind: 'BET',
      amount: '26.00',
      externalTransactionId,
      idempotencyKey,
    });

    expect(conflict.status).toBe(409);
    expect((conflict.body as unknown as { error: string }).error).toBe('IDEMPOTENCY_CONFLICT');
    expect(await ledgerSum(app.orm, wallet.id)).toBe('75.00');
  });

  test('payload que difere so na formatacao do valor ainda e replay', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const externalTransactionId = uuidv7();

    const first = await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00', externalTransactionId });
    const replay = await submit(baseUrl, wallet, { kind: 'BET', amount: '25.0', externalTransactionId });

    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
  });
});

describe.skipIf(!reachable)('consultas e reconciliacao', () => {
  let app: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    app = await startTestApp();
    baseUrl = app.baseUrl;
  });

  afterAll(async () => {
    await app?.stop();
  });

  test('a wallet pode ser consultada por id', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const result = await getJson<{ balance: { amount: string } }>(baseUrl, `/wallets/${wallet.id}`);

    expect(result.status).toBe(200);
    expect(result.body.balance.amount).toBe('100.00');
  });

  test('a transacao pode ser consultada por id interno e por id do provedor', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    const externalTransactionId = uuidv7();
    const submitted = await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00', externalTransactionId });

    const byId = await getJson<{ id: string }>(baseUrl, `/wagering/transactions/${submitted.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body.id).toBe(submitted.body.transactionId);

    const byExternal = await getJson<{ id: string }>(
      baseUrl,
      `/providers/provider-a/wagering/transactions/${externalTransactionId}`,
    );
    expect(byExternal.status).toBe(200);
    expect(byExternal.body.id).toBe(submitted.body.transactionId);
  });

  test('o ledger pagina com cursor estavel e nunca repete um lancamento', async () => {
    const wallet = await createWallet(baseUrl, '1000.00');

    for (let index = 0; index < 7; index += 1) {
      await submit(baseUrl, wallet, { kind: 'BET', amount: '1.00' });
    }

    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page += 1) {
      const path = `/wallets/${wallet.id}/ledger?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const result = await getJson<{ entries: Array<{ id: string }>; nextCursor?: string }>(baseUrl, path);

      expect(result.status).toBe(200);
      seen.push(...result.body.entries.map((entry) => entry.id));

      if (!result.body.nextCursor) {
        break;
      }
      cursor = result.body.nextCursor;
    }

    expect(seen.length).toBe(8);
    expect(new Set(seen).size).toBe(8);
  });

  test('a reconciliacao confirma uma wallet consistente', async () => {
    const wallet = await createWallet(baseUrl, '100.00');
    await submit(baseUrl, wallet, { kind: 'BET', amount: '25.00' });
    await submit(baseUrl, wallet, { kind: 'WIN', amount: '10.00' });

    const result = await postJson<{
      consistent: boolean;
      storedBalance: { amount: string };
      calculatedBalance: { amount: string };
      difference: { amount: string };
      checkedEntries: number;
    }>(baseUrl, `/wallets/${wallet.id}/reconciliation`, {});

    expect(result.status).toBe(200);
    expect(result.body.consistent).toBe(true);
    expect(result.body.storedBalance.amount).toBe('85.00');
    expect(result.body.calculatedBalance.amount).toBe('85.00');
    expect(result.body.difference.amount).toBe('0.00');
    expect(result.body.checkedEntries).toBe(3);
  });

  test('a reconciliacao sinaliza a divergencia em vez de corrigir em silencio', async () => {
    const wallet = await createWallet(baseUrl, '100.00');

    await query(app.orm, 'update wallets set balance_amount = 123.45 where id = ?', [wallet.id]);

    const result = await postJson<{ consistent: boolean; difference: { amount: string } }>(
      baseUrl,
      `/wallets/${wallet.id}/reconciliation`,
      {},
    );

    expect(result.status).toBe(200);
    expect(result.body.consistent).toBe(false);
    expect(result.body.difference.amount).toBe('23.45');

    expect(
      await countRows(app.orm, 'reconciliation_checks', 'wallet_id = ? and consistent = false', [wallet.id]),
    ).toBe(1);

    const stillWrong = await query<{ balance_amount: string }>(
      app.orm,
      'select balance_amount from wallets where id = ?',
      [wallet.id],
    );
    expect(stillWrong[0]?.balance_amount).toBe('123.45');
  });

  test('os endpoints de health e metrics respondem sem autenticacao', async () => {
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);

    const metrics = await fetch(`${baseUrl}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('wagering_transactions_total');
  });
});
