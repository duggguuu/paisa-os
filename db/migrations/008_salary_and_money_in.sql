-- Paisa OS 008: salary profile + payslips (for the tax simulator), and "money in that isn't income".
-- Additive: two new tables, one function, a new category group per book, and a flag on two
-- existing income categories (refunds and gifts are money in, not earnings).

create table salary_profile (
  book_id          uuid primary key references book(id) on delete cascade,
  employer         text,
  account_id       uuid references account(id) on delete set null,     -- where the salary lands
  rule_id          uuid references recurring_rule(id) on delete set null,
  pay_day          int not null default 31 check (pay_day between 1 and 31), -- 31 = last day of the month
  earnings         jsonb not null default '[]',   -- [{name, monthly}] paise, per month (Basic, HRA, …)
  deductions       jsonb not null default '[]',   -- [{name, monthly, kind: pf|pt|tds|nps|other}]
  employer_contrib jsonb not null default '[]',   -- [{name, monthly, kind: pf|nps|gratuity|other}]
  annual_bonus     bigint not null default 0,
  updated_at       timestamptz not null default now()
);

create table salary_slip (
  id               uuid primary key default gen_random_uuid(),
  book_id          uuid not null references book(id) on delete cascade,
  month            date not null,                 -- first day of the month the slip is for
  earnings         jsonb not null default '[]',
  deductions       jsonb not null default '[]',
  employer_contrib jsonb not null default '[]',
  gross            bigint not null,
  net              bigint not null,
  tds              bigint not null default 0,
  note             text,
  created_at       timestamptz not null default now(),
  unique (book_id, month)
);

-- Income = an income category not flagged not_income (itself or its parent).
create or replace function counts_as_income(a account) returns boolean language sql stable as $$
  select a.class = 'income'
     and not coalesce((a.meta->>'not_income')::boolean, false)
     and not exists (select 1 from account p where p.id = a.parent_id and coalesce((p.meta->>'not_income')::boolean, false))
$$;

-- A "Money in (not income)" group in every book that doesn't have one.
with books as (
  select b.id from book b
  where not exists (select 1 from account a where a.book_id = b.id and a.kind = 'category' and a.class = 'income' and a.parent_id is null and lower(a.name) = 'money in (not income)')
), parents as (
  insert into account (book_id, class, kind, name, icon, sort, meta)
  select id, 'income', 'category', 'Money in (not income)', '📥', 90, '{"not_income": true}'::jsonb from books
  returning id, book_id
)
insert into account (book_id, class, kind, name, parent_id, sort, meta)
select p.book_id, 'income', 'category', c.name, p.id, c.sort, '{"not_income": true}'::jsonb
from parents p cross join (values ('Repayments', 0), ('From family', 1), ('Reimbursements', 2), ('Other money in', 3)) as c(name, sort);

update account set meta = meta || '{"not_income": true}'::jsonb
where kind = 'category' and class = 'income' and parent_id is null and name in ('Refunds & cashback', 'Gifts received');
