import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000000InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "player_id" uuid not null,
        "currency" char(3) not null,
        "balance_amount" numeric(20,2) not null,
        "version" integer not null default 1,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_balance_non_negative" check ("balance_amount" >= 0),
        constraint "wallets_version_positive" check ("version" >= 1),
        constraint "wallets_currency_format" check ("currency" ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      create unique index "wallets_player_currency_unique"
        on "wallets" ("player_id", "currency");
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(64) not null,
        "external_transaction_id" varchar(128) not null,
        "idempotency_key" varchar(255) not null,
        "payload_hash" char(64) not null,
        "wallet_id" uuid not null,
        "player_id" uuid not null,
        "round_id" varchar(128) not null,
        "game_id" varchar(128) not null,
        "kind" varchar(16) not null,
        "currency" char(3) not null,
        "amount" numeric(20,2) not null,
        "reference_external_transaction_id" varchar(128) null,
        "status" varchar(16) not null,
        "reference_transaction_id" uuid null,
        "failure_code" varchar(48) null,
        "observed_balance_amount" numeric(20,2) null,
        "created_at" timestamptz not null,
        "processed_at" timestamptz null,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_wallet_fk"
          foreign key ("wallet_id") references "wallets" ("id"),
        constraint "wager_transactions_reference_fk"
          foreign key ("reference_transaction_id") references "wager_transactions" ("id"),
        constraint "wager_transactions_amount_positive" check ("amount" > 0),
        constraint "wager_transactions_kind_valid"
          check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_valid"
          check ("status" in ('PENDING', 'PROCESSED', 'REJECTED')),
        constraint "wager_transactions_reference_required"
          check ("kind" not in ('REFUND', 'ROLLBACK') or "reference_external_transaction_id" is not null),
        constraint "wager_transactions_no_self_reference"
          check (
            "reference_external_transaction_id" is null
            or "reference_external_transaction_id" <> "external_transaction_id"
          ),
        constraint "wager_transactions_failure_code_matches_status"
          check (("status" = 'REJECTED') = ("failure_code" is not null)),
        constraint "wager_transactions_terminal_has_processed_at"
          check ("status" = 'PENDING' or "processed_at" is not null)
      );
    `);

    this.addSql(`
      create unique index "wager_transactions_idempotency_key_unique"
        on "wager_transactions" ("idempotency_key");
    `);

    this.addSql(`
      create unique index "wager_transactions_provider_external_unique"
        on "wager_transactions" ("provider_id", "external_transaction_id");
    `);

    this.addSql(`
      create unique index "wager_transactions_single_reversal_per_kind"
        on "wager_transactions" ("provider_id", "reference_external_transaction_id", "kind")
        where "status" = 'PROCESSED' and "kind" in ('REFUND', 'ROLLBACK');
    `);

    this.addSql(`
      create index "wager_transactions_wallet_created"
        on "wager_transactions" ("wallet_id", "created_at" desc);
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(8) not null,
        "currency" char(3) not null,
        "amount" numeric(20,2) not null,
        "balance_before_amount" numeric(20,2) not null,
        "balance_after_amount" numeric(20,2) not null,
        "created_at" timestamptz not null,
        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "wallet_ledger_entries_wallet_fk"
          foreign key ("wallet_id") references "wallets" ("id"),
        constraint "wallet_ledger_entries_transaction_fk"
          foreign key ("transaction_id") references "wager_transactions" ("id"),
        constraint "wallet_ledger_entries_direction_valid"
          check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_entries_amount_positive" check ("amount" > 0),
        constraint "wallet_ledger_entries_balance_before_non_negative"
          check ("balance_before_amount" >= 0),
        constraint "wallet_ledger_entries_balance_after_non_negative"
          check ("balance_after_amount" >= 0),
        constraint "wallet_ledger_entries_arithmetic" check (
          "balance_after_amount" = "balance_before_amount"
            + (case "direction" when 'CREDIT' then "amount" else -"amount" end)
        )
      );
    `);

    this.addSql(`
      create unique index "wallet_ledger_entries_one_per_wallet_transaction"
        on "wallet_ledger_entries" ("wallet_id", "transaction_id");
    `);

    this.addSql(`
      create index "wallet_ledger_entries_wallet_cursor"
        on "wallet_ledger_entries" ("wallet_id", "created_at" desc, "id" desc);
    `);

    this.addSql(`
      create or replace function "reject_ledger_mutation"() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries is append-only, % is not allowed', tg_op
          using errcode = '23514';
      end;
      $$ language plpgsql;
    `);

    this.addSql(`
      create trigger "wallet_ledger_entries_block_update"
        before update on "wallet_ledger_entries"
        for each row execute function "reject_ledger_mutation"();
    `);

    this.addSql(`
      create trigger "wallet_ledger_entries_block_delete"
        before delete on "wallet_ledger_entries"
        for each row execute function "reject_ledger_mutation"();
    `);

    this.addSql(`
      create trigger "wallet_ledger_entries_block_truncate"
        before truncate on "wallet_ledger_entries"
        for each statement execute function "reject_ledger_mutation"();
    `);

    this.addSql(`
      create table "outbox_messages" (
        "id" uuid not null,
        "aggregate_id" varchar(128) not null,
        "event_type" varchar(128) not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "published_at" timestamptz null,
        constraint "outbox_messages_pkey" primary key ("id")
      );
    `);

    this.addSql(`
      create index "outbox_messages_pending"
        on "outbox_messages" ("occurred_at")
        where "published_at" is null;
    `);

    this.addSql(`
      create table "reconciliation_checks" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "currency" char(3) not null,
        "stored_amount" numeric(20,2) not null,
        "calculated_amount" numeric(20,2) not null,
        "difference_amount" numeric(20,2) not null,
        "consistent" boolean not null,
        "checked_entries" integer not null,
        "checked_at" timestamptz not null,
        constraint "reconciliation_checks_pkey" primary key ("id"),
        constraint "reconciliation_checks_wallet_fk"
          foreign key ("wallet_id") references "wallets" ("id")
      );
    `);

    this.addSql(`
      create index "reconciliation_checks_divergent"
        on "reconciliation_checks" ("checked_at" desc)
        where "consistent" = false;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "reconciliation_checks" cascade;`);
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
    this.addSql(`drop trigger if exists "wallet_ledger_entries_block_truncate" on "wallet_ledger_entries";`);
    this.addSql(`drop trigger if exists "wallet_ledger_entries_block_delete" on "wallet_ledger_entries";`);
    this.addSql(`drop trigger if exists "wallet_ledger_entries_block_update" on "wallet_ledger_entries";`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
    this.addSql(`drop function if exists "reject_ledger_mutation"();`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop table if exists "wallets" cascade;`);
  }
}
