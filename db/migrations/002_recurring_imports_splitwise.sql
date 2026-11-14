-- Paisa OS 002: recurring bills, statement/CAS imports, Splitwise sync.
-- Additive only: new tables, new nullable columns, new enum values. No existing rows change.

-- New sources for transactions (values are only added, never removed).
alter type txn_source add value if not exists 'recurring';
alter type txn_source add value if not exists 'splitwise';
alter type txn_source add value if not exists 'receipt';

-- ---------- recurring bills / SIPs / salary ----------
create type recur_cadence as enum ('weekly', 'monthly', 'yearly');

create table recurring_rule (
  id             uuid primary key default gen_random_uuid(),
  book_id        uuid not null references book(id) on delete cascade,
  name           text not null,
  kind           text not null check (kind in ('expense', 'income', 'transfer')),
  amount         bigint not null check (amount > 0),
  account_id     uuid not null references account(id),     -- pays (expense/transfer) or receives (income)
  category_id    uuid references account(id),              -- expense/income
  to_account_id  uuid references account(id),              -- transfer target (SIP → investments, card bill → card)
  merchant       text,
  cadence        recur_cadence not null default 'monthly',
  day            int not null check (day between 1 and 31), -- day of month (monthly/yearly) or 1-7 Mon..Sun (weekly)
  month          int check (month between 1 and 12),        -- yearly only
  next_due       date not null,
  end_date       date,
  auto_post      boolean not null default false,             -- log automatically on the due date
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  constraint recurring_shape check (
    (kind = 'transfer' and to_account_id is not null) or (kind <> 'transfer' and category_id is not null)
  )
);
create index recurring_book on recurring_rule (book_id) where is_active;

alter table txn add column if not exists recurring_id uuid references recurring_rule(id);

-- ---------- imports (bank statements, CAS, Splitwise) ----------
create table import_batch (
  id                uuid primary key default gen_random_uuid(),
  book_id           uuid not null references book(id) on delete cascade,
  account_id        uuid references account(id),
  source            text not null,            -- 'statement' | 'cas' | 'splitwise'
  file_name         text,
  imported_at       timestamptz not null default now(),
  rows_total        int not null default 0,
  rows_imported     int not null default 0,
  closing_balance   bigint,                   -- from the statement, for reconciliation
  closing_date      date,
  meta              jsonb not null default '{}'
);
create index import_batch_book on import_batch (book_id, imported_at desc);

alter table txn add column if not exists import_batch_id uuid references import_batch(id);

-- ---------- Splitwise ----------
create table splitwise_link (
  book_id             uuid primary key references book(id) on delete cascade,
  api_key_enc         text not null,
  sw_user_id          bigint not null,
  sw_user_name        text,
  default_account_id  uuid references account(id),   -- where your share is paid from / settle-ups land
  last_synced_at      timestamptz
);
