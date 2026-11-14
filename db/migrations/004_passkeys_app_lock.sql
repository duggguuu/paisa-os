-- Paisa OS 004: Face ID / Touch ID via passkeys (WebAuthn), and an app lock. Additive only.

-- One row per device passkey. The private key never leaves the phone; we keep the public key.
create table webauthn_credential (
  id            text primary key,                 -- base64url credential id
  user_id       uuid not null references app_user(id) on delete cascade,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  device_name   text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index webauthn_credential_user on webauthn_credential (user_id);

-- App lock: when on, a session must be unlocked with a passkey after `lock_minutes` idle.
alter table app_user add column if not exists lock_enabled boolean not null default false;
alter table app_user add column if not exists lock_minutes int not null default 5 check (lock_minutes between 1 and 1440);
alter table session add column if not exists unlocked_until timestamptz;
