import { describe, expect, test } from 'bun:test';
import { computePayloadHash, defaultIdempotencyKey, toCanonicalJson } from '../../src/shared/payload-hash';

const base = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonical json', () => {
  test('orders keys so the hash does not depend on the order they arrived in', () => {
    expect(toCanonicalJson({ b: 'two', a: 'one' })).toBe(toCanonicalJson({ a: 'one', b: 'two' }));
  });

  test('drops undefined but keeps null', () => {
    expect(toCanonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  test('refuses raw numbers so money can never be hashed as a float', () => {
    expect(() => toCanonicalJson({ amount: 25.0 })).toThrow();
  });
});

describe('computePayloadHash', () => {
  test('is the same for an identical payload', () => {
    expect(computePayloadHash(base)).toBe(computePayloadHash({ ...base }));
  });

  test('does not depend on the order of the fields', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: base.walletId,
      playerId: base.playerId,
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };

    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base));
  });

  test('normalizes the amount scale before hashing', () => {
    expect(computePayloadHash({ ...base, money: { amount: '25', currency: 'BRL' } })).toBe(computePayloadHash(base));
    expect(computePayloadHash({ ...base, money: { amount: '25.0', currency: 'BRL' } })).toBe(computePayloadHash(base));
  });

  test('changes when any business field changes', () => {
    const original = computePayloadHash(base);

    expect(computePayloadHash({ ...base, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(original);
    expect(computePayloadHash({ ...base, money: { amount: '25.00', currency: 'USD' } })).not.toBe(original);
    expect(computePayloadHash({ ...base, kind: 'WIN' })).not.toBe(original);
    expect(computePayloadHash({ ...base, roundId: 'round-988' })).not.toBe(original);
    expect(computePayloadHash({ ...base, gameId: 'other-game' })).not.toBe(original);
    expect(computePayloadHash({ ...base, providerId: 'provider-b' })).not.toBe(original);
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: 'bet-1' })).not.toBe(original);
  });

  test('treats a missing reference and an explicit undefined reference as the same payload', () => {
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: undefined })).toBe(computePayloadHash(base));
  });

  test('builds the recommended default idempotency key', () => {
    expect(defaultIdempotencyKey('provider-a', 'transaction-123')).toBe('provider-a:transaction-123');
  });
});
