import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeSql, migrate } from './db.js';
import { buildApp } from './app.js';
import { hashPassword } from './crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const required = (k: string) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing env var ${k}`); process.exit(1); }
  return v;
};

const sql = makeSql(required('DATABASE_URL'));
const applied = await migrate(sql);
if (applied.length) console.log('Applied migrations:', applied.join(', '));

// Password recovery without email: whoever controls the server's settings sets RESET_OWNER_PASSWORD,
// restarts, logs in with it, then deletes the variable. All sessions and the laptop PIN are cleared.
const reset = process.env.RESET_OWNER_PASSWORD;
if (reset) {
  if (reset.length < 10) console.error('RESET_OWNER_PASSWORD must be at least 10 characters; ignored.');
  else {
    const n = await sql`update app_user set password_hash = ${await hashPassword(reset)}, pin_hash = null, pin_length = null, pin_failures = 0`;
    await sql`delete from session`;
    console.warn(`Owner password reset (${n.count} user). All sessions ended. REMOVE RESET_OWNER_PASSWORD from the environment now.`);
  }
}

const port = Number(process.env.PORT ?? 8080);
// RENDER_EXTERNAL_URL is set automatically on Render, so PUBLIC_URL is optional there.
const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, '');
const app = await buildApp({
  sql,
  appSecret: required('APP_SECRET'),
  publicUrl,
  webDist: process.env.WEB_DIST ?? [path.resolve(here, '../../web/dist'), path.resolve(here, '../../../web/dist')].find((d) => fs.existsSync(d)),
  secureCookies: publicUrl.startsWith('https://'),
  logger: true,
  // Behind a hosting proxy (Render, Railway…) so req.ip is the real client, used for login rate limiting.
  trustProxy: process.env.TRUST_PROXY === '1' || !!process.env.RENDER,
});
await app.listen({ port, host: '0.0.0.0' });
