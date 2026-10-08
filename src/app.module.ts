import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import ormConfig from './mikro-orm.config';
import { OutboxRepository } from './outbox/outbox.repository';
import { AppLogger } from './shared/logger';
import { AppMetrics } from './shared/metrics';
import { WageringController } from './wagering/wagering.controller';
import { WageringService } from './wagering/wagering.service';
import { WagerTransactionRepository } from './wagering/wager-transaction.repository';
import { WalletController } from './wallet/wallet.controller';
import { WalletRepository } from './wallet/wallet.repository';
import { WalletService } from './wallet/wallet.service';

@Module({
  controllers: [WalletController, WageringController, HealthController],
  providers: [
    { provide: MikroORM, useFactory: async () => MikroORM.init(ormConfig) },
    AppLogger,
    AppMetrics,
    WalletRepository,
    WagerTransactionRepository,
    OutboxRepository,
    WalletService,
    WageringService,
  ],
})
export class AppModule {}
