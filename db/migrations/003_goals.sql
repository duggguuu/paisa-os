-- Paisa OS 003: savings goals. Additive only.
--
-- A goal either tracks a linked account (an FD, a savings account, an investment account:
-- progress = that account's balance), or keeps its own contributions (money you've set aside
-- in your head, without moving it). Contributions are earmarks, not ledger postings, so they
-- never change balances, spending or net worth.

create table goal (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references book(id) on delete cascade,
  name         text not null,
  icon         text,
  target       bigint not null check (target > 0),
  target_date  date,
  account_id   uuid references account(id),
  sort         int not null default 0,
  archived     boolean not null default false,
  created_at   timestamptz not null default now()
);
create index goal_book on goal (book_id) where not archived;

create table goal_contribution (
  id          uuid primary key default gen_random_uuid(),
  goal_id     uuid not null references goal(id) on delete cascade,
  book_id     uuid not null references book(id) on delete cascade,
  occurred_on date not null,
  amount      bigint not null check (amount <> 0),   -- negative = took money back out
  note        text,
  txn_id      uuid references txn(id),               -- set when the boost also moved real money
  created_at  timestamptz not null default now()
);
create index goal_contribution_goal on goal_contribution (goal_id, occurred_on);
