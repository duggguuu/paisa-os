-- Paisa OS 010: mandates & subscriptions (on recurring rules), renewal reminders, push notifications.
-- Additive only.

-- Repeat every N cycles (monthly + every 3 = quarterly, + every 6 = half-yearly; weekly + every 2 = fortnightly).
alter table recurring_rule add column if not exists every int not null default 1 check (every between 1 and 24);
-- Mandate / subscription details; null = an ordinary bill.
--   {type: subscription|upi_autopay|enach|card_autopay|standing_instruction|other, provider, umrn, max_amount, notes}
alter table recurring_rule add column if not exists mandate jsonb;
-- Renewal reminders: [{days_before: 0..30, hour: 0..23 (IST)}]
alter table recurring_rule add column if not exists reminders jsonb not null default '[]';

-- What to notify: the three daily "add your expenses" nudges, and whether notifications may show amounts.
alter table app_user add column if not exists notify_prefs jsonb not null
  default '{"daily": {"enabled": true, "hours": [9, 14, 21]}, "amounts": false}';

-- Devices that accepted notifications (Web Push).
create table push_subscription (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_user(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  device      text,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz
);

-- Small server settings (the Web Push signing keys live here).
create table app_setting (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Every notification sent, by a stable key, so a reminder is never sent twice.
create table notification_log (
  key      text primary key,
  sent_at  timestamptz not null default now()
);
