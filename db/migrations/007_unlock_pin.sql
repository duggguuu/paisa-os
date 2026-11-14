-- Paisa OS 007: a short PIN to unlock on a laptop browser (Face ID stays on the phone). Additive only.
-- The PIN only unlocks a session that's already logged in; it never logs in by itself.
alter table app_user add column if not exists pin_hash text;
alter table app_user add column if not exists pin_length int check (pin_length between 4 and 6);
alter table app_user add column if not exists pin_failures int not null default 0;
