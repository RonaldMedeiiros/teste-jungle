import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { outboxMessageSchema } from './outbox/outbox.repository';
import { wagerTransactionSchema } from './wagering/wager-transaction.repository';
import { ledgerEntrySchema, reconciliationCheckSchema, walletSchema } from './wallet/wallet.repository';

export default defineConfig({
  host: process.env['DATABASE_HOST'] ?? 'localhost',
  port: Number.parseInt(process.env['DATABASE_PORT'] ?? '5433', 10),
  dbName: process.env['DATABASE_NAME'] ?? 'jungle_wagering',
  user: process.env['DATABASE_USER'] ?? 'jungle',
  password: process.env['DATABASE_PASSWORD'] ?? 'jungle',
  entities: [walletSchema, ledgerEntrySchema, wagerTransactionSchema, outboxMessageSchema, reconciliationCheckSchema],
  discovery: { disableDynamicFileAccess: true },
  pool: { min: 2, max: 20 },
  forceUtcTimezone: true,
  debug: process.env['LOG_LEVEL'] === 'debug',
  extensions: [Migrator],
  migrations: {
    path: './src/migrations',
    pathTs: './src/migrations',
    glob: '!(*.d).{js,ts}',
    tableName: 'mikro_orm_migrations',
    transactional: true,
    allOrNothing: true,
    emit: 'ts',
  },
});
