import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptableScript, WIDGET_FEATURES } from '../src/widget-script.ts';

// Minimal stand-ins for Scriptable's API, enough to run the script end to end.
function scriptable(family: string | undefined, param: string, payload: any, cache: Record<string, string> = {}) {
  const texts: string[] = [];
  class Stack { addText(s: string) { texts.push(s); return { font: null, textColor: null, lineLimit: 1, minimumScaleFactor: 1, centerAlignText() {} }; }
    addStack() { return new Stack(); } addSpacer() {} addImage() { return { imageSize: null }; } layoutHorizontally() {} layoutVertically() {} centerAlignContent() {} setPadding() {} }
  class ListWidget extends Stack { url = ''; refreshAfterDate: any = null; backgroundGradient: any = null; async presentSmall() {} async presentMedium() {} async presentLarge() {} }
  const g: any = {
    args: { widgetParameter: param }, config: { widgetFamily: family, runsInWidget: !!family },
    Color: Object.assign(function (this: any, h: string) { this.h = h; }, { dynamic: (a: any) => a, white: () => ({}) }),
    Font: { boldSystemFont: () => ({}), semiboldSystemFont: () => ({}), systemFont: () => ({}), boldMonospacedSystemFont: () => ({}), mediumMonospacedSystemFont: () => ({}) },
    Size: function () {}, Rect: function () {}, Path: class { addRoundedRect() {} },
    DrawContext: class { size: any; opaque = false; respectScreenScale = false; addPath() {} setFillColor() {} fillPath() {} getImage() { return {}; } },
    LinearGradient: class { colors: any; locations: any },
    ListWidget,
    Request: class { timeoutInterval = 0; response: any = null; constructor(public url: string) {}
      async loadJSON() { if (!payload) throw new Error('offline'); this.response = { statusCode: 200 }; return payload; } },
    FileManager: { local: () => ({ joinPath: (a: string, b: string) => `${a}/${b}`, documentsDirectory: () => '/docs',
      writeString: (p: string, s: string) => { cache[p] = s; }, readString: (p: string) => cache[p], fileExists: (p: string) => p in cache }) },
    Script: { setWidget() {}, complete() {} },
  };
  const src = scriptableScript('https://x/api/widget/data?t=abc', 'https://x');
  const fn = new Function(...Object.keys(g), `return (async () => {${src}})();`);
  return { run: () => fn(...Object.values(g)), texts, cache };
}

const sample = {
  asOf: '2026-11-16T10:00:00Z', month: { from: '2026-11-01', to: '2026-12-01', daysLeft: 15, daysTotal: 30 },
  safeToSpend: { amount: 12_345_00, perDay: 823_00 }, thisMonth: { spent: 42_000_00, earned: 1_20_000_00 },
  netWorth: { total: 7_33_269_00, assets: 7_47_487_00, liabilities: 14_218_00 },
  budget: { limit: 50_000_00, spent: 42_000_00, top: [{ name: 'Food', icon: '🍔', limit: 10_000_00, spent: 9_500_00 }] },
  bills: [{ name: 'Rent', amount: 25_000_00, due: '2026-11-18', overdue: false, today: false }],
  fds: { count: 2, principal: 3_00_000_00, valueNow: 3_05_000_00, atMaturity: 3_40_000_00, next: { name: 'PostBank TD', maturity: '2027-11-16', atMaturity: 1_07_000_00, daysLeft: 365 } },
  goals: [{ name: 'Trip', icon: '✈️', saved: 40_000_00, target: 1_00_000_00, progress: 0.4 }],
  topSpending: [{ name: 'Food', icon: '🍔', amount: 9_500_00 }], hideAmounts: false, appUrl: 'https://x',
};

test('iPhone widget script runs for every feature and size', async () => {
  for (const fam of ['small', 'medium', 'large', 'accessoryRectangular', 'accessoryInline', 'accessoryCircular', undefined]) {
    for (const f of WIDGET_FEATURES) {
      const s = scriptable(fam, f.id, sample);
      await s.run();
      assert.ok(s.texts.length > 0, `${fam}/${f.id} drew something`);
    }
  }
  const s = scriptable('medium', 'networth', sample); await s.run();
  assert.ok(s.texts.includes('₹7,33,269'), 'Indian digit grouping');
});

test('iPhone widget script hides amounts and works offline from its copy', async () => {
  const h = scriptable('medium', 'networth,hide', sample); await h.run();
  assert.ok(h.texts.includes('₹ ••••'));
  assert.ok(!h.texts.some((t) => t.includes('7,33,269')));
  const first = scriptable('small', 'spend', sample); await first.run();
  const off = scriptable('small', 'spend', null, first.cache); await off.run();
  assert.ok(off.texts.includes('offline'));
  assert.ok(off.texts.includes('₹12,345'));
  const none = scriptable('small', 'spend', null); await none.run();
  assert.ok(none.texts.includes('Offline'));
});
