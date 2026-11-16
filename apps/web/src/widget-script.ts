/**
 * The Scriptable script for iPhone home-screen and Lock Screen widgets. Settings → Widgets copies it
 * with the user's view-only link filled in. It runs inside the Scriptable app (not here), so it only
 * uses Scriptable's own APIs and plain JavaScript.
 *
 * Widget "Parameter" (long-press the widget → Edit Widget) picks what it shows:
 *   overview (default) · spend · month · networth · budget · bills · fds · goals · top
 * Add ",hide" to hide amounts on that widget, e.g. "networth,hide".
 */
export const WIDGET_FEATURES: { id: string; label: string; sizes: string }[] = [
  { id: 'overview', label: 'Overview: safe to spend, this month, net worth', sizes: 'all' },
  { id: 'spend', label: 'Safe to spend, per day', sizes: 'all' },
  { id: 'month', label: 'This month: spent and earned', sizes: 'all' },
  { id: 'networth', label: 'Net worth', sizes: 'all' },
  { id: 'budget', label: 'Budget used, with the busiest categories', sizes: 'all' },
  { id: 'bills', label: 'Bills due in the next week', sizes: 'all' },
  { id: 'fds', label: 'FDs: worth today and next maturity', sizes: 'all' },
  { id: 'goals', label: 'Goals progress', sizes: 'all' },
  { id: 'top', label: 'Top spending categories this month', sizes: 'all' },
];

export function scriptableScript(dataUrl: string, appUrl: string): string {
  return `// Paisa OS widget for Scriptable (https://scriptable.app)
// Widget parameter: overview | spend | month | networth | budget | bills | fds | goals | top
// Add ",hide" to hide amounts, e.g.  networth,hide
// This link can only read a summary. Turn it off any time in Paisa → Settings → Widgets.
const DATA_URL = ${JSON.stringify(dataUrl)};
const APP_URL = ${JSON.stringify(appUrl)};

const param = String(args.widgetParameter || '').toLowerCase().split(',').map((s) => s.trim());
const feature = param[0] || 'overview';
const family = config.widgetFamily || 'medium';
const lock = family.startsWith('accessory');

const C = {
  bg1: Color.dynamic(new Color('#ffffff'), new Color('#151515')),
  bg2: Color.dynamic(new Color('#eeeeee'), new Color('#0b0b0b')),
  ink: Color.dynamic(new Color('#111111'), new Color('#f2f2f2')),
  sub: Color.dynamic(new Color('#6b6b6b'), new Color('#9a9a9a')),
  track: Color.dynamic(new Color('#e3e3e3'), new Color('#2a2a2a')),
  good: new Color('#1f9d55'), warn: new Color('#d98a00'), bad: new Color('#d64545'),
};

// ---------- data (with an offline copy) ----------
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), 'paisa-widget-cache.json');
let data = null, stale = false, problem = null;
try {
  const r = new Request(DATA_URL);
  r.timeoutInterval = 25;
  const j = await r.loadJSON();
  if (r.response && r.response.statusCode === 200) { data = j; fm.writeString(cachePath, JSON.stringify(j)); }
  else problem = (j && j.message) || 'Paisa didn\\'t answer';
} catch (e) { problem = 'Offline'; }
if (!data && fm.fileExists(cachePath)) { try { data = JSON.parse(fm.readString(cachePath)); stale = true; } catch (e) {} }
const hide = !!(data && data.hideAmounts) || param.includes('hide');

// ---------- formatting (Indian style: 1,23,456 · 1.2L · 3.4Cr) ----------
function group(n) {
  const s = String(Math.abs(Math.round(n)));
  if (s.length <= 3) return s;
  const last = s.slice(-3); let rest = s.slice(0, -3); const parts = [];
  while (rest.length > 2) { parts.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
  if (rest) parts.unshift(rest);
  return parts.join(',') + ',' + last;
}
function rs(paise) { if (hide) return '₹ ••••'; const v = paise / 100; return (v < 0 ? '−₹' : '₹') + group(v); }
function short(paise) {
  if (hide) return '₹••';
  const v = paise / 100, a = Math.abs(v), sign = v < 0 ? '−' : '';
  if (a >= 1e7) return sign + '₹' + (a / 1e7).toFixed(a >= 1e8 ? 0 : 1) + 'Cr';
  if (a >= 1e5) return sign + '₹' + (a / 1e5).toFixed(a >= 1e6 ? 0 : 1) + 'L';
  if (a >= 1e3) return sign + '₹' + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  return sign + '₹' + Math.round(a);
}
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function day(iso) { return Number(iso.slice(8, 10)) + ' ' + MON[Number(iso.slice(5, 7)) - 1]; }
function pct(x) { return Math.round(Math.max(0, x) * 100) + '%'; }

// ---------- drawing helpers ----------
const W = { small: 155, medium: 329, large: 329, extraLarge: 690 }[family] || 300;
function text(parent, s, size, opts = {}) {
  const t = parent.addText(String(s));
  t.font = opts.bold ? Font.boldSystemFont(size) : opts.semi ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  if (opts.mono) t.font = opts.bold ? Font.boldMonospacedSystemFont(size) : Font.mediumMonospacedSystemFont(size);
  t.textColor = opts.color || C.ink; t.lineLimit = opts.lines || 1; t.minimumScaleFactor = 0.5;
  return t;
}
function bar(parent, frac, width, color) {
  const h = 6, dc = new DrawContext();
  dc.size = new Size(width, h); dc.opaque = false; dc.respectScreenScale = true;
  const p1 = new Path(); p1.addRoundedRect(new Rect(0, 0, width, h), 3, 3); dc.addPath(p1); dc.setFillColor(C.track); dc.fillPath();
  const f = Math.max(0, Math.min(1, frac));
  if (f > 0) { const p2 = new Path(); p2.addRoundedRect(new Rect(0, 0, Math.max(h, width * f), h), 3, 3); dc.addPath(p2); dc.setFillColor(color); dc.fillPath(); }
  const img = parent.addImage(dc.getImage()); img.imageSize = new Size(width, h);
}
function row(parent, left, right, size, color) {
  const s = parent.addStack(); s.layoutHorizontally(); s.centerAlignContent();
  text(s, left, size, { color: C.sub }); s.addSpacer(); text(s, right, size, { semi: true, color: color || C.ink });
  return s;
}
function header(w, label) {
  const s = w.addStack(); s.layoutHorizontally(); s.centerAlignContent();
  text(s, label.toUpperCase(), 10.5, { semi: true, color: C.sub }); s.addSpacer();
  text(s, stale ? 'offline' : 'Paisa', 10.5, { color: C.sub });
  w.addSpacer(family === 'small' ? 6 : 8);
}
function budgetColor(f) { return f >= 1 ? C.bad : f >= 0.85 ? C.warn : C.good; }

// ---------- what each feature shows ----------
function spend(w) {
  const s = data.safeToSpend, m = data.month;
  header(w, 'Safe to spend');
  text(w, rs(s.amount), family === 'small' ? 24 : 30, { bold: true, color: s.amount < 0 ? C.bad : C.ink });
  w.addSpacer(4);
  text(w, s.amount > 0 ? 'about ' + rs(s.perDay) + ' a day' : 'over plan this month', 12, { color: C.sub });
  if (family !== 'small') { w.addSpacer(8); bar(w, 1 - m.daysLeft / m.daysTotal, W - 32, C.ink); w.addSpacer(4); text(w, m.daysLeft + ' days left in the month', 11, { color: C.sub }); }
  if (family === 'large') { w.addSpacer(14); month(w, true); }
}
function month(w, inner) {
  const t = data.thisMonth;
  if (!inner) header(w, 'This month');
  const big = family === 'small' ? 20 : 24;
  text(w, rs(t.spent), big, { bold: true }); text(w, 'spent', 11, { color: C.sub });
  w.addSpacer(6);
  row(w, 'Earned', rs(t.earned), 12, C.good);
  row(w, 'Left over', rs(t.earned - t.spent), 12, t.earned - t.spent < 0 ? C.bad : C.ink);
  if (family === 'large' && !inner) { w.addSpacer(14); top(w, true); }
}
function networth(w) {
  const n = data.netWorth;
  header(w, 'Net worth');
  text(w, rs(n.total), family === 'small' ? 22 : 30, { bold: true, color: n.total < 0 ? C.bad : C.ink });
  w.addSpacer(8);
  row(w, 'You own', short(n.assets), 12); row(w, 'You owe', short(n.liabilities), 12);
  if (family !== 'small') { w.addSpacer(8); bar(w, n.assets > 0 ? 1 - n.liabilities / n.assets : 0, W - 32, C.good); }
  if (family === 'large') { w.addSpacer(14); fds(w, true); }
}
function budget(w) {
  const b = data.budget;
  header(w, 'Budget');
  if (!b.limit) { text(w, 'No budgets set', 14, { semi: true }); text(w, 'Add them in Paisa → Budgets', 11, { color: C.sub, lines: 2 }); return; }
  const f = b.spent / b.limit;
  text(w, pct(f) + ' used', family === 'small' ? 22 : 26, { bold: true, color: budgetColor(f) });
  text(w, rs(b.spent) + ' of ' + short(b.limit), 11.5, { color: C.sub });
  w.addSpacer(6); bar(w, f, W - 32, budgetColor(f));
  if (family !== 'small') {
    const n = family === 'large' ? 4 : 2; w.addSpacer(8);
    for (const c of b.top.slice(0, n)) { const cf = c.spent / Math.max(c.limit, 1); row(w, (c.icon ? c.icon + ' ' : '') + c.name, pct(cf), 11.5, budgetColor(cf)); if (family === 'large') { bar(w, cf, W - 32, budgetColor(cf)); w.addSpacer(4); } }
  }
}
function bills(w) {
  header(w, 'Bills this week');
  const list = data.bills;
  if (!list.length) { text(w, 'Nothing due', 16, { semi: true }); text(w, 'in the next 7 days', 11, { color: C.sub }); return; }
  const n = family === 'small' ? 2 : family === 'medium' ? 3 : 5;
  for (const b of list.slice(0, n)) {
    const s = w.addStack(); s.layoutHorizontally(); s.centerAlignContent();
    const l = s.addStack(); l.layoutVertically();
    text(l, b.name, 12.5, { semi: true });
    text(l, b.overdue ? 'Overdue · ' + day(b.due) : b.today ? 'Due today' : day(b.due), 10.5, { color: b.overdue ? C.bad : b.today ? C.warn : C.sub });
    s.addSpacer(); text(s, short(b.amount), 12.5, { semi: true });
    w.addSpacer(5);
  }
}
function fds(w, inner) {
  const f = data.fds;
  if (!inner) header(w, 'Fixed deposits');
  if (!f.count) { text(w, 'No FDs yet', 14, { semi: true }); return; }
  text(w, rs(f.valueNow), inner ? 18 : family === 'small' ? 20 : 26, { bold: true });
  text(w, 'worth today · ' + f.count + ' FD' + (f.count === 1 ? '' : 's'), 11, { color: C.sub });
  w.addSpacer(6);
  row(w, 'At maturity', short(f.atMaturity), 11.5, C.good);
  if (f.next && family !== 'small') row(w, 'Next: ' + f.next.name, day(f.next.maturity), 11.5);
  else if (f.next) text(w, 'Next ' + day(f.next.maturity), 11, { color: C.sub });
}
function goals(w) {
  header(w, 'Goals');
  const g = data.goals;
  if (!g.length) { text(w, 'No goals yet', 14, { semi: true }); return; }
  const n = family === 'small' ? 1 : family === 'medium' ? 2 : 4;
  for (const x of g.slice(0, n)) {
    row(w, (x.icon ? x.icon + ' ' : '') + x.name, pct(x.progress), 12.5, C.good);
    if (family !== 'small') text(w, rs(x.saved) + ' of ' + short(x.target), 10.5, { color: C.sub });
    w.addSpacer(3); bar(w, x.progress, W - 32, C.good); w.addSpacer(8);
  }
}
function top(w, inner) {
  if (!inner) header(w, 'Top spending');
  const t = data.topSpending;
  if (!t.length) { text(w, 'No spending yet', 14, { semi: true }); return; }
  const max = Math.max(...t.map((c) => c.amount), 1);
  for (const c of t.slice(0, family === 'small' ? 2 : 3)) {
    row(w, (c.icon ? c.icon + ' ' : '') + c.name, short(c.amount), 12);
    if (family !== 'small') { w.addSpacer(2); bar(w, c.amount / max, W - 32, C.ink); }
    w.addSpacer(5);
  }
}
function overview(w) {
  if (family === 'small') { spend(w); return; }
  const s = data.safeToSpend, t = data.thisMonth, n = data.netWorth;
  header(w, 'This month');
  const top2 = w.addStack(); top2.layoutHorizontally();
  const a = top2.addStack(); a.layoutVertically();
  text(a, 'Safe to spend', 11, { color: C.sub }); text(a, short(s.amount), 22, { bold: true, color: s.amount < 0 ? C.bad : C.ink });
  top2.addSpacer();
  const b = top2.addStack(); b.layoutVertically();
  text(b, 'Spent', 11, { color: C.sub }); text(b, short(t.spent), 22, { bold: true });
  top2.addSpacer();
  const c = top2.addStack(); c.layoutVertically();
  text(c, 'Net worth', 11, { color: C.sub }); text(c, short(n.total), 22, { bold: true });
  w.addSpacer(10);
  if (data.budget.limit) { const f = data.budget.spent / data.budget.limit; row(w, 'Budget used', pct(f), 11.5, budgetColor(f)); w.addSpacer(3); bar(w, f, W - 32, budgetColor(f)); }
  if (family === 'large') { w.addSpacer(16); bills(w); w.addSpacer(8); goals(w); }
}

// ---------- Lock Screen sizes ----------
function lockWidget(w) {
  const s = data.safeToSpend, n = data.netWorth, b = data.budget, f = data.fds;
  const pick = {
    spend: ['Safe to spend', short(s.amount)], overview: ['Safe to spend', short(s.amount)],
    month: ['Spent', short(data.thisMonth.spent)], networth: ['Net worth', short(n.total)],
    budget: ['Budget', b.limit ? pct(b.spent / b.limit) : '—'], fds: ['FDs', short(f.valueNow)],
    bills: ['Bills', data.bills.length ? data.bills[0].name : 'none'], goals: ['Goal', data.goals.length ? pct(data.goals[0].progress) : '—'],
    top: ['Top', data.topSpending.length ? data.topSpending[0].name : '—'],
  }[feature] || ['Safe to spend', short(s.amount)];
  if (family === 'accessoryInline') { text(w, '₹ ' + pick[0] + ' ' + pick[1].replace('₹', ''), 12); return; }
  if (family === 'accessoryCircular') { w.addSpacer(); text(w, pick[1], 13, { bold: true }).centerAlignText(); text(w, pick[0].split(' ')[0], 9).centerAlignText(); w.addSpacer(); return; }
  text(w, pick[0], 11, { semi: true }); text(w, pick[1], 18, { bold: true });
  if (feature === 'bills' && data.bills.length) text(w, data.bills[0].overdue ? 'overdue' : day(data.bills[0].due), 10);
  else text(w, data.month.daysLeft + ' days left', 10);
}

// ---------- build ----------
const w = new ListWidget();
w.url = APP_URL;
w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
if (!lock) {
  const g = new LinearGradient(); g.colors = [C.bg1, C.bg2]; g.locations = [0, 1]; w.backgroundGradient = g;
  w.setPadding(14, 16, 14, 16);
}
if (!data) {
  text(w, 'Paisa', 14, { bold: true }); w.addSpacer(4);
  text(w, problem || 'Couldn\\'t load', 11, { color: C.sub, lines: 3 });
} else if (lock) {
  lockWidget(w);
} else {
  ({ overview, spend, month, networth, budget, bills, fds, goals, top }[feature] || overview)(w);
  w.addSpacer();
}

if (config.runsInWidget) Script.setWidget(w);
else if (family === 'small') await w.presentSmall();
else if (family === 'large') await w.presentLarge();
else await w.presentMedium();
Script.complete();
`;
}
