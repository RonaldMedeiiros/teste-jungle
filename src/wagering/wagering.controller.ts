import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { idempotencyKeySchema, parseOrThrow, submitTransactionSchema } from '../shared/contracts';
import { InvalidRequestError, TransactionNotFoundError } from '../shared/errors';
import { WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';
import { WageringService } from './wagering.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller()
export class WageringController {
  constructor(private readonly wagering: WageringService) {}

  @Post('wagering/transactions')
  async create(
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    if (!idempotencyKeyHeader) {
      throw new InvalidRequestError('Idempotency-Key header is required', [
        { path: 'Idempotency-Key', message: 'header is required' },
      ]);
    }

    const idempotencyKey = parseOrThrow(idempotencyKeySchema, idempotencyKeyHeader);
    const parsed = parseOrThrow(submitTransactionSchema, body);

    const result = await this.wagering.submit({
      idempotencyKey,
      providerId: parsed.providerId,
      externalTransactionId: parsed.externalTransactionId,
      playerId: parsed.playerId,
      walletId: parsed.walletId,
      roundId: parsed.roundId,
      gameId: parsed.gameId,
      kind: parsed.kind as WagerTransactionKind,
      money: parsed.money,
      referenceExternalTransactionId: parsed.referenceExternalTransactionId,
    });

    const status =
      result.status === WagerTransactionStatus.Processed ? HttpStatus.OK : HttpStatus.UNPROCESSABLE_ENTITY;

    response.status(status).json(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    if (!UUID_PATTERN.test(transactionId)) {
      throw new InvalidRequestError('transactionId must be a uuid', [
        { path: 'transactionId', message: 'expected a uuid' },
      ]);
    }

    const view = await this.wagering.getById(transactionId);
    if (!view) {
      throw new TransactionNotFoundError(transactionId);
    }
    return view;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const view = await this.wagering.getByProviderAndExternalId(providerId, externalTransactionId);
    if (!view) {
      throw new TransactionNotFoundError(`${providerId}:${externalTransactionId}`);
    }
    return view;
  }
}
