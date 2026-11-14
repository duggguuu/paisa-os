/**
 * Passkeys (WebAuthn) for "Log in with Face ID" and the app lock.
 *
 * On iPhone, a passkey is unlocked with Face ID (or Touch ID / device passcode). The phone keeps
 * the private key; the server stores only the public key and verifies signatures with
 * @simplewebauthn/server. Challenges travel in a short-lived signed cookie, so nothing about
 * an in-progress ceremony is stored in the database.
 */
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { Sql } from './db.js';
import { LedgerError } from './ledger.js';

export interface PasskeyConfig { rpID: string; origin: string; rpName: string }

export function passkeyConfig(publicUrl: string): PasskeyConfig {
  const u = new URL(publicUrl);
  return { rpID: u.hostname, origin: u.origin, rpName: 'Paisa OS' };
}

type Cred = { id: string; public_key: Buffer; counter: number; transports: string[] };

async function credsFor(sql: Sql, userId?: string) {
  return userId
    ? sql<Cred[]>`select id, public_key, counter, transports from webauthn_credential where user_id = ${userId}`
    : sql<Cred[]>`select id, public_key, counter, transports from webauthn_credential`;
}

export async function registrationOptions(sql: Sql, cfg: PasskeyConfig, userId: string) {
  const [u] = await sql<{ email: string }[]>`select email from app_user where id = ${userId}`;
  const existing = await credsFor(sql, userId);
  return generateRegistrationOptions({
    rpName: cfg.rpName, rpID: cfg.rpID,
    userName: u.email, userDisplayName: u.email,
    userID: new TextEncoder().encode(userId),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports as any })),
    // Platform authenticator (Face ID / Touch ID on this phone), user verification required.
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
    timeout: 60_000,
  });
}

export async function verifyRegistration(sql: Sql, cfg: PasskeyConfig, userId: string, challenge: string, response: any, deviceName: string | null) {
  const v = await verifyRegistrationResponse({
    response, expectedChallenge: challenge, expectedOrigin: cfg.origin, expectedRPID: cfg.rpID, requireUserVerification: true,
  }).catch((e: Error) => { throw new LedgerError('passkey_failed', `Couldn't set up Face ID: ${e.message}`, 400); });
  if (!v.verified || !v.registrationInfo) throw new LedgerError('passkey_failed', "Couldn't set up Face ID", 400);
  const c = v.registrationInfo.credential;
  await sql`insert into webauthn_credential (id, user_id, public_key, counter, transports, device_name)
            values (${c.id}, ${userId}, ${Buffer.from(c.publicKey)}, ${c.counter}, ${(c.transports ?? []) as string[]}, ${deviceName})
            on conflict (id) do nothing`;
  return { id: c.id };
}

/** Options for a Face ID prompt. `userId` limits it to that owner's passkeys (unlock); omit for login. */
export async function authenticationOptions(sql: Sql, cfg: PasskeyConfig, userId?: string) {
  const creds = await credsFor(sql, userId);
  if (!creds.length) throw new LedgerError('no_passkey', 'Face ID is not set up on this account yet. Log in with your password, then turn it on in Settings.', 400);
  return generateAuthenticationOptions({
    rpID: cfg.rpID, userVerification: 'required', timeout: 60_000,
    allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as any })),
  });
}

/** Verify a Face ID assertion; returns the owner's user id. */
export async function verifyAuthentication(sql: Sql, cfg: PasskeyConfig, challenge: string, response: any, userId?: string) {
  const [c] = await sql<(Cred & { user_id: string })[]>`
    select id, user_id, public_key, counter, transports from webauthn_credential where id = ${String(response?.id ?? '')}`;
  if (!c || (userId && c.user_id !== userId)) throw new LedgerError('passkey_unknown', 'This passkey isn\'t registered here', 401);
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge: challenge, expectedOrigin: cfg.origin, expectedRPID: cfg.rpID, requireUserVerification: true,
    credential: { id: c.id, publicKey: new Uint8Array(c.public_key), counter: Number(c.counter), transports: c.transports as any },
  }).catch((e: Error) => { throw new LedgerError('passkey_failed', `Face ID check failed: ${e.message}`, 401); });
  if (!v.verified) throw new LedgerError('passkey_failed', 'Face ID check failed', 401);
  await sql`update webauthn_credential set counter = ${v.authenticationInfo.newCounter}, last_used_at = now() where id = ${c.id}`;
  return c.user_id;
}

export async function listPasskeys(sql: Sql, userId: string) {
  return sql<any[]>`select id, device_name, created_at, last_used_at from webauthn_credential where user_id = ${userId} order by created_at`;
}

export async function removePasskey(sql: Sql, userId: string, id: string) {
  await sql.begin(async (tx) => {
    await tx`delete from webauthn_credential where id = ${id} and user_id = ${userId}`;
    // No passkeys left: the lock can't be opened with Face ID any more, so turn it off.
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from webauthn_credential where user_id = ${userId}`;
    if (n === 0) await tx`update app_user set lock_enabled = false where id = ${userId}`;
  });
}
