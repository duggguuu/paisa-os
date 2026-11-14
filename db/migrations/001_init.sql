-- Paisa OS: core schema
-- Money is stored as bigint paise. Positive posting = debit, negative = credit.
-- Asset and expense accounts grow with debits; liability, income and equity grow with credits.

create extension if not exists pgcrypto;

create table app_user (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table session (
  token_hash  text primary key,
  user_id     uuid not null references app_user(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- A book is one self-contained ledger. Each user has a real book and a demo book;
-- demo data can never mix with real data because every row is scoped to a book.
create table book (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app_user(id) on delete cascade,
  name            text not null,
  is_demo         boolean not null default false,
  currency        char(3) not null default 'INR',
  month_start_day int not null default 1 check (month_start_day between 1 and 28),
  created_at      timestamptz not null default now(),
  unique (user_id, is_demo)
);

create type account_class as enum ('asset', 'liability', 'income', 'expense', 'equity');
create type account_kind as enum (
  'bank', 'cash', 'credit_card', 'wallet', 'fd', 'loan', 'investment',
  'receivable', 'payable', 'category', 'equity'
);

create table account (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references book(id) on delete cascade,
  class        account_class not null,
  kind         account_kind not null,
  name         text not null,
  parent_id    uuid references account(id),
  institution  text,
  currency     char(3) not null default 'INR',
  icon         text,
  color        text,
  is_archived  boolean not null default false,
  -- card cycle day, due day, interest rate, kite flag, etc.
  meta         jsonb not null default '{}',
  sort         int not null default 0,
  created_at   timestamptz not null default now(),
  constraint category_class check ((kind = 'category') = (class in ('income', 'expense'))),
  constraint kind_class check (
    (kind in ('bank','cash','wallet','fd','investment','receivable') and class = 'asset') or
    (kind in ('credit_card','loan','payable') and class = 'liability') or
    (kind = 'equity' and class = 'equity') or
    (kind = 'category')
  )
);
create unique index account_name_unique on account (book_id, class, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index account_book on account (book_id);

create type txn_source as enum ('manual', 'voice', 'sms', 'import', 'verified', 'system');
create type txn_status as enum ('posted', 'void');
create type txn_kind as enum ('expense', 'income', 'transfer', 'split', 'opening', 'adjustment', 'refund');

create table txn (
  id               uuid primary key default gen_random_uuid(),
  book_id          uuid not null references book(id) on delete cascade,
  kind             txn_kind not null,
  occurred_on      date not null,
  description      text,
  merchant         text,
  note             text,
  tags             text[] not null default '{}',
  source           txn_source not null default 'manual',
  status           txn_status not null default 'posted',
  external_ref     text,          -- UPI reference / bank ref, used for dedupe
  idempotency_key  uuid,
  refund_of        uuid references txn(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (book_id, idempotency_key)
);
create index txn_book_date on txn (book_id, occurred_on desc) where status = 'posted';
create unique index txn_external_ref on txn (book_id, external_ref) where external_ref is not null and status = 'posted';

create table posting (
  id          bigserial primary key,
  txn_id      uuid not null references txn(id) on delete cascade,
  account_id  uuid not null references account(id),
  amount      bigint not null check (amount <> 0),
  memo        text
);
create index posting_txn on posting (txn_id);
create index posting_account on posting (account_id);

-- Every transaction's postings must sum to zero and stay inside one book.
-- Deferred so a transaction's postings can be inserted one by one inside a db transaction.
create function check_txn_balanced() returns trigger language plpgsql as $$
declare
  t uuid := coalesce(new.txn_id, old.txn_id);
  total bigint;
  n int;
  foreign_rows int;
begin
  if not exists (select 1 from txn where id = t) then
    return null; -- txn deleted in the same db transaction
  end if;
  select coalesce(sum(amount), 0), count(*) into total, n from posting where txn_id = t;
  if n < 2 then
    raise exception 'transaction % must have at least two postings (has %)', t, n;
  end if;
  if total <> 0 then
    raise exception 'transaction % is unbalanced: postings sum to % paise', t, total;
  end if;
  select count(*) into foreign_rows
    from posting p join account a on a.id = p.account_id join txn x on x.id = p.txn_id
   where p.txn_id = t and a.book_id <> x.book_id;
  if foreign_rows > 0 then
    raise exception 'transaction % posts to an account from another book', t;
  end if;
  return null;
end $$;

create constraint trigger posting_balanced
  after insert or update or delete on posting
  deferrable initially deferred
  for each row execute function check_txn_balanced();

-- Append-only audit log
create table audit_log (
  id         bigserial primary key,
  book_id    uuid not null,
  entity     text not null,
  entity_id  text not null,
  action     text not null,
  before     jsonb,
  after      jsonb,
  source     text,
  at         timestamptz not null default now()
);
create index audit_entity on audit_log (entity, entity_id);

create function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_immutable();

create type budget_period as enum ('weekly', 'monthly', 'annual');
create table budget (
  id          uuid primary key default gen_random_uuid(),
  book_id     uuid not null references book(id) on delete cascade,
  category_id uuid not null references account(id),
  period      budget_period not null default 'monthly',
  amount      bigint not null check (amount > 0),
  rollover    boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (book_id, category_id, period)
);

-- Investment holdings pulled from Zerodha (or CAS). Snapshots, never overwritten.
create table holding_snapshot (
  id           bigserial primary key,
  book_id      uuid not null references book(id) on delete cascade,
  account_id   uuid not null references account(id),
  taken_at     timestamptz not null default now(),
  source       text not null,           -- 'kite' | 'cas' | 'manual'
  instrument   text not null,
  isin         text,
  asset_type   text not null check (asset_type in ('equity', 'mf')),
  quantity     numeric(20, 6) not null,
  avg_price    numeric(20, 6) not null,
  last_price   numeric(20, 6) not null,
  value_paise  bigint not null
);
create index holding_latest on holding_snapshot (account_id, taken_at desc);

create table kite_link (
  book_id            uuid primary key references book(id) on delete cascade,
  api_key            text not null,
  api_secret_enc     text not null,
  access_token_enc   text,
  token_obtained_at  timestamptz,
  kite_user_id       text
);
