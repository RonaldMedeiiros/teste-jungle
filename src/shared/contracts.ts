import { z } from 'zod';
import { InvalidRequestError } from './errors';

export const moneySchema = z
  .object({
    amount: z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,2})?$/, 'amount must be a plain decimal string with at most 2 decimal places'),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, 'currency must be a 3 letter ISO-4217 code')
      .transform((value) => value.toUpperCase()),
  })
  .strict();

export const submittableKindSchema = z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']);

export const openWalletSchema = z
  .object({
    playerId: z.string().uuid(),
    initialBalance: moneySchema,
  })
  .strict();

export const submitTransactionSchema = z
  .object({
    providerId: z.string().trim().min(1).max(64),
    externalTransactionId: z.string().trim().min(1).max(128),
    playerId: z.string().uuid(),
    walletId: z.string().uuid(),
    roundId: z.string().trim().min(1).max(128),
    gameId: z.string().trim().min(1).max(128),
    kind: submittableKindSchema,
    money: moneySchema,
    referenceExternalTransactionId: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const needsReference = value.kind === 'REFUND' || value.kind === 'ROLLBACK';
    if (needsReference && !value.referenceExternalTransactionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['referenceExternalTransactionId'],
        message: `${value.kind} requires referenceExternalTransactionId`,
      });
    }
    if (value.referenceExternalTransactionId === value.externalTransactionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['referenceExternalTransactionId'],
        message: 'a transaction cannot reference itself',
      });
    }
  });

export const ledgerQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const idempotencyKeySchema = z.string().trim().min(1).max(255);

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new InvalidRequestError(
      'request payload is invalid',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  return result.data;
}

export type OpenWalletBody = z.infer<typeof openWalletSchema>;
export type SubmitTransactionBody = z.infer<typeof submitTransactionSchema>;
