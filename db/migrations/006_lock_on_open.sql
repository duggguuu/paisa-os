-- Paisa OS 006: lock on every open. Additive, plus turning the lock on for existing owners.

-- Each app open (a new tab, or the iPhone app starting fresh) must unlock. An unlock hands that
-- tab a random key (kept in sessionStorage); the session stores the hashes of recent keys.
alter table session add column if not exists unlock_keys text[] not null default '{}';
alter table app_user add column if not exists lock_on_open boolean not null default true;

-- The lock no longer needs a passkey (the password unlocks it too), so turn it on for everyone.
update app_user set lock_enabled = true;
