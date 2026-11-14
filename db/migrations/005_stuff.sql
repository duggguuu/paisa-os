-- Paisa OS 005: Stuff — the things you own, want, asked about, dropped or sold. Additive only.
-- Mirrors the "Yash's Stuff" sheet (tabs Own / Want / Asked about / Dropped) and links items to
-- the ledger: buying creates the expense, selling creates the income.

create table stuff_item (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references book(id) on delete cascade,
  list         text not null check (list in ('own', 'want', 'asked', 'dropped', 'sold')),
  name         text not null,
  category     text,
  notes        text,
  price        bigint,                 -- paise: list price (want/asked) or what you paid (own)
  store        text,
  link         text,
  meta         jsonb not null default '{}',   -- brand, colour, size, art_no, verdict, asked_when, …
  acquired_on  date,
  txn_id       uuid references txn(id),       -- the purchase
  sold_on      date,
  sold_price   bigint,
  sale_txn_id  uuid references txn(id),       -- the sale
  sort         int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index stuff_item_book_list on stuff_item (book_id, list);
