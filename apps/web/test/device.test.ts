import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const UA = {
  pixel: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921B Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  reduced: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
};
const setUa = (ua: string, touch = 0) => Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua, maxTouchPoints: touch }, configurable: true });

test('device: Android says Fingerprint and names the phone; iPhone says Face ID', async () => {
  const d = await import('../src/device.ts');
  setUa(UA.pixel);
  assert.equal(d.platform(), 'android'); assert.equal(d.bio(), 'Fingerprint'); assert.equal(d.bioIcon(), 'fingerprint'); assert.equal(d.deviceName(), 'Pixel 9');
  setUa(UA.samsung); assert.equal(d.deviceName(), 'SM-S921B');
  setUa(UA.reduced); assert.equal(d.deviceName(), 'Android phone');
  setUa(UA.iphone); assert.equal(d.platform(), 'iphone'); assert.equal(d.bio(), 'Face ID'); assert.equal(d.deviceName(), 'iPhone');
  setUa(UA.mac); assert.equal(d.bio(), 'Touch ID');
  setUa(UA.mac, 5); assert.equal(d.platform(), 'ipad');
});

test('manifest: installable on Android with shortcuts', () => {
  const m = JSON.parse(fs.readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i: any) => i.sizes === '512x512' && i.purpose === 'maskable'));
  assert.ok(m.icons.some((i: any) => i.sizes === '192x192'));
  assert.deepEqual(m.shortcuts.map((s: any) => s.url), ['/?add=1', '/?add=voice', '/activity', '/stats']);
});
