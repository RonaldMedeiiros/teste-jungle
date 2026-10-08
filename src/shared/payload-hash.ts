import { createHash } from 'node:crypto';
import { Money, MoneyProps } from './money';

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export function toCanonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function computePayloadHash(payload: WagerPayload): string {
  const canonical = toCanonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
  });

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function defaultIdempotencyKey(providerId: string, externalTransactionId: string): string {
  return `${providerId}:${externalTransactionId}`;
}

function normalize(value: unknown): unknown {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const normalized = normalize(source[key]);
      if (normalized !== undefined) {
        result[key] = normalized;
      }
    }
    return result;
  }
  if (typeof value === 'number') {
    throw new Error('canonical json does not accept numbers, use decimal strings');
  }
  return value;
}
