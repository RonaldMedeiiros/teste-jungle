import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry } from 'prom-client';

@Injectable()
export class AppMetrics {
  readonly registry = new Registry();

  readonly transactions: Counter<'kind' | 'status' | 'failureCode'>;
  readonly replays: Counter<string>;
  readonly conflicts: Counter<string>;
  readonly lockRetries: Counter<string>;
  readonly divergences: Counter<string>;
  readonly duration: Histogram<'kind'>;

  constructor() {
    this.transactions = new Counter({
      name: 'wagering_transactions_total',
      help: 'wager transactions by kind, final status and failure code',
      labelNames: ['kind', 'status', 'failureCode'],
      registers: [this.registry],
    });

    this.replays = new Counter({
      name: 'wagering_idempotent_replays_total',
      help: 'requests answered from an already persisted transaction',
      registers: [this.registry],
    });

    this.conflicts = new Counter({
      name: 'wagering_idempotency_conflicts_total',
      help: 'same idempotency key submitted with a different payload',
      registers: [this.registry],
    });

    this.lockRetries = new Counter({
      name: 'wagering_lock_retries_total',
      help: 'transactions retried after a lock or unique conflict',
      registers: [this.registry],
    });

    this.divergences = new Counter({
      name: 'wagering_reconciliation_divergences_total',
      help: 'wallets whose stored balance diverged from the ledger',
      registers: [this.registry],
    });

    this.duration = new Histogram({
      name: 'wagering_processing_duration_seconds',
      help: 'duration of processing a wager transaction',
      labelNames: ['kind'],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry],
    });
  }

  async expose(): Promise<string> {
    return this.registry.metrics();
  }
}
