-- Paisa OS 012: two optional details on a transaction.
--   mood: the mindset behind a spend (essential, impulse, splurge…). The list lives in the app
--         (apps/api/src/ledger.ts MOODS, apps/web/src/moods.ts), so new moods need no migration.
--   pay_method: how money left (or moved from) a bank account: debit card, UPI or net banking.
alter table txn add column if not exists mood text;
alter table txn drop constraint if exists txn_mood_check;
alter table txn add constraint txn_mood_check check (mood is null or mood ~ '^[a-z_]{2,24}$');
create index if not exists txn_book_mood on txn (book_id, mood) where mood is not null and status = 'posted';

alter table txn add column if not exists pay_method text;
alter table txn drop constraint if exists txn_pay_method_check;
alter table txn add constraint txn_pay_method_check check (pay_method is null or pay_method in ('debit_card', 'upi', 'netbanking'));
