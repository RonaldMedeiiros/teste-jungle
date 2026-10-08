import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ledgerQuerySchema, openWalletSchema, parseOrThrow } from '../shared/contracts';
import { InvalidRequestError } from '../shared/errors';
import { LEDGER_DEFAULT_LIMIT, WalletService } from './wallet.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('wallets')
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    const parsed = parseOrThrow(openWalletSchema, body);
    return this.wallets.open(parsed.playerId, parsed.initialBalance);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    assertUuid(walletId, 'walletId');
    return this.wallets.getById(walletId);
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    assertUuid(walletId, 'walletId');
    const parsed = parseOrThrow(ledgerQuerySchema, query);
    return this.wallets.getLedger(walletId, parsed.limit ?? LEDGER_DEFAULT_LIMIT, parsed.cursor);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconciliation(@Param('walletId') walletId: string) {
    assertUuid(walletId, 'walletId');
    return this.wallets.reconcile(walletId);
  }
}

function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidRequestError(`${field} must be a uuid`, [{ path: field, message: 'expected a uuid' }]);
  }
}
