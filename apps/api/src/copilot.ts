/**
 * Copilot: "ask anything about your money".
 *
 * Two engines, same context:
 *  - local (default, free, nothing leaves the server): recognises the common questions
 *    (afford X, save more, why spending rose, goals, budgets, bills, net worth, health,
 *    "how much on X") and answers from the numbers.
 *  - Claude (only when ANTHROPIC_API_KEY is set on the server): starts from a compact summary of
 *    the book and calls read-only tools (copilot-tools.ts) to look up transactions, any period,
 *    investments, loans, bills, salary and goals; it can draft entries for the owner to confirm.
 *    Falls back to the local engine on any error.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Sql } from './db.js';
import { summary, byCategory, byMerchant, resolvePeriod } from './stats.js';
import { netWorth, safeToSpend } from './dashboard.js';
import { upcoming } from './recurring.js';
import { listGoals } from './goals.js';
import { healthScore } from './planner.js';
import { insights } from './insights.js';
import { addDays, daysIn, todayIST } from './money.js';
import { TOOLS, runTool, type Draft } from './copilot-tools.js';

const r = (p: number) => `₹${Math.round(Math.abs(p) / 100).toLocaleString('en-IN')}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (d: string) => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

export async function buildContext(sql: Sql, bookId: string, monthStartDay: number, today = todayIST()) {
  const ranges = resolvePeriod('month', today, monthStartDay);
  const month = ranges.current;
  const [sum, prev, cats, merchants, sts, nw, bills, goals, health, ins] = await Promise.all([
    summary(sql, bookId, month, today),
    ranges.previous ? summary(sql, bookId, ranges.previous, today) : null,
    byCategory(sql, bookId, 'month', ranges),
    byMerchant(sql, bookId, month),
    safeToSpend(sql, bookId, monthStartDay, today),
    netWorth(sql, bookId),
    upcoming(sql, bookId, month, today),
    listGoals(sql, bookId, today),
    healthScore(sql, bookId, monthStartDay, today),
    insights(sql, bookId, monthStartDay, today),
  ]);
  const totalDays = daysIn(month), elapsed = daysIn({ from: month.from, to: addDays(today, 1) });
  return { today, month, totalDays, elapsed, sum, prev, cats, merchants, sts, nw, bills, goals, health, ins };
}
type Ctx = Awaited<ReturnType<typeof buildContext>>;

/** What Claude sees: rupees, rounded, no account numbers or individual transactions. */
function contextForModel(c: Ctx) {
  const rs = (p: number | null | undefined) => (p == null ? null : Math.round(p / 100));
  return {
    today: c.today, currency: 'INR (amounts in rupees)',
    month: { from: c.month.from, to_exclusive: c.month.to, days_elapsed: c.elapsed, days_total: c.totalDays },
    this_month: { income: rs(c.sum.earned), spent: rs(c.sum.spent), saved: rs(c.sum.saved), savings_rate: c.sum.savingsRate },
    same_point_last_month: c.prev && { income: rs(c.prev.earned), spent: rs(c.prev.spent) },
    safe_to_spend: { amount: rs(c.sts.amount), in_bank_cash_wallets: rs(c.sts.spendable), card_dues: rs(c.sts.cardDues), bills_still_due: rs(c.sts.upcomingBills), unspent_budgets: rs(c.sts.reservedForBudgets) },
    categories: c.cats.slice(0, 15).map((x) => ({ name: x.name, spent: rs(x.amount), same_point_last_month: rs(x.previous), usual_month: rs(x.avg3), budget: rs(x.budget) })),
    top_merchants: c.merchants.slice(0, 8).map((m: any) => ({ name: m.name, spent: rs(m.amount), payments: m.count })),
    bills_due_this_month: c.bills.items.slice(0, 12).map((b) => ({ name: b.name, date: b.date, amount: rs(b.amount), overdue: b.overdue })),
    goals: c.goals.map((g) => ({ name: g.name, saved: rs(g.saved), target: rs(g.target), target_date: g.targetDate, pace_per_month: rs(g.pacePerMonth), projected_finish: g.reachOn, needed_per_month: rs(g.neededPerMonth) })),
    net_worth: { assets: rs(c.nw.assets), liabilities: rs(c.nw.liabilities), net: rs(c.nw.netWorth),
      by_type: Object.entries(c.nw.accounts.reduce((m: Record<string, number>, a) => ({ ...m, [a.kind]: (m[a.kind] ?? 0) + a.balance }), {})).map(([k, v]) => ({ type: k, total: rs(v as number) })) },
    financial_health: { score: c.health.score, label: c.health.label, parts: c.health.parts.map((p) => ({ part: p.label, score: p.score, detail: p.detail })) },
    observations: c.ins.slice(0, 8).map((i) => i.title),
  };
}

// ---------- local engine ----------
function parseAmount(q: string): number | null {
  const m = q.replace(/,/g, '').match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(k|thousand|l|lakh|lakhs|lac|cr|crore)?\b/i);
  if (!m) return null;
  const unit = (m[2] ?? '').toLowerCase();
  const mult = unit.startsWith('k') || unit === 'thousand' ? 1e3 : ['l', 'lakh', 'lakhs', 'lac'].includes(unit) ? 1e5 : unit.startsWith('cr') ? 1e7 : 1;
  const v = Number(m[1]) * mult;
  return v > 0 ? Math.round(v * 100) : null;
}

function avgMonthlySaving(c: Ctx) {
  const income = c.sum.earned, spent = c.sum.spent;
  const projectedSpent = c.elapsed ? (spent / c.elapsed) * c.totalDays : spent;
  return income > 0 ? Math.max(0, income - projectedSpent) : 0;
}

export function localAnswer(question: string, c: Ctx): string {
  const q = question.toLowerCase();
  const sts = c.sts.amount;

  if (/afford|can i (buy|get|spend)|should i (buy|get)/.test(q)) {
    const amt = parseAmount(q);
    if (!amt) return `Tell me the price and I'll check it, e.g. "Can I afford a ₹60,000 laptop?". Right now you have **${r(sts)}** safe to spend this month.`;
    const liquid = c.nw.accounts.filter((a) => ['bank', 'cash', 'wallet'].includes(a.kind)).reduce((s, a) => s + a.balance, 0);
    const monthSpend = c.elapsed ? (c.sum.spent / c.elapsed) * c.totalDays : c.sum.spent;
    const bufferAfter = monthSpend > 0 ? (liquid - amt) / monthSpend : null;
    const save = avgMonthlySaving(c);
    if (amt <= sts * 0.5) return `**Yes, comfortably.** ${r(amt)} is ${Math.round((amt / Math.max(sts, 1)) * 100)}% of the ${r(sts)} that's safe to spend this month, after bills, card dues and budgets.`;
    if (amt <= sts) return `**Yes, but it's a big chunk.** It leaves ${r(sts - amt)} safe to spend for the remaining ${c.totalDays - c.elapsed + 1} days of the month. Consider waiting if anything else big is coming up.`;
    const lines = [`**Not from this month's money.** You have ${r(sts)} safe to spend; ${r(amt)} is ${r(amt - sts)} more than that.`];
    if (bufferAfter !== null) lines.push(bufferAfter >= 3 ? `Your savings could cover it and still leave about ${bufferAfter.toFixed(1)} months of spending as a buffer.` : `Paying from savings would leave only ${Math.max(bufferAfter, 0).toFixed(1)} months of spending as a buffer (3–6 is the usual safety net).`);
    if (save > 0) lines.push(`At your current pace you save about ${r(save)} a month, so you could fund it in about **${Math.ceil((amt - Math.max(sts, 0)) / save)} month(s)**. A goal would track that for you.`);
    return lines.join('\n\n');
  }

  if (/why.*(spend|spent|spending|expens)|spend.*(increase|higher|up|more)|went up/.test(q)) {
    if (!c.prev) return 'I need a previous month of data to compare against.';
    const diff = c.sum.spent - c.prev.spent;
    const movers = c.cats.filter((x) => x.previous !== null).map((x) => ({ ...x, d: x.amount - (x.previous ?? 0) })).sort((a, b) => b.d - a.d);
    const up = movers.filter((m) => m.d > 0).slice(0, 3);
    const down = movers.filter((m) => m.d < 0).slice(-2);
    const head = diff > 0 ? `You've spent **${r(diff)} more** than by this point last month (${r(c.sum.spent)} vs ${r(c.prev.spent)}).` : `Actually, you've spent **${r(-diff)} less** than by this point last month (${r(c.sum.spent)} vs ${r(c.prev.spent)}).`;
    const lines = [head];
    if (up.length) lines.push('Biggest increases:\n' + up.map((m) => `• ${m.icon ?? ''} ${m.name}: +${r(m.d)} (${r(m.amount)} vs ${r(m.previous ?? 0)})`).join('\n'));
    if (down.length && diff > 0) lines.push('Partly offset by: ' + down.map((m) => `${m.name} (−${r(-m.d)})`).join(', ') + '.');
    return lines.join('\n\n');
  }

  if (/save more|save money|saving more|cut (back|down)|reduce|spend less|how (can|do) i save/.test(q)) {
    const hot = c.cats.filter((x) => x.avg3 && x.avg3 > 0).map((x) => ({ ...x, proj: c.elapsed ? (x.amount / c.elapsed) * c.totalDays : x.amount }))
      .filter((x) => x.proj > (x.avg3 ?? 0) * 1.1).sort((a, b) => (b.proj - (b.avg3 ?? 0)) - (a.proj - (a.avg3 ?? 0))).slice(0, 3);
    const subs = c.ins.filter((i) => i.id.startsWith('sub-')).slice(0, 3);
    const flexible = c.cats.filter((x) => !/housing|rent|bills|insurance|tax|education|health/i.test(x.name)).slice(0, 2);
    const lines = [c.sum.savingsRate !== null ? `You're keeping **${Math.round(c.sum.savingsRate * 100)}%** of your income this month.` : 'Log your income to see your savings rate.'];
    if (hot.length) lines.push('Running above your usual month:\n' + hot.map((h) => `• ${h.name}: on pace for ${r(h.proj)} vs usual ${r(h.avg3 ?? 0)}. Getting back to usual saves ${r(h.proj - (h.avg3 ?? 0))}.`).join('\n'));
    if (flexible.length) lines.push('Trimming flexible spending by 15%:\n' + flexible.map((f) => `• ${f.name}: about ${r((f.avg3 || f.amount) * 0.15)} a month`).join('\n'));
    if (subs.length) lines.push(`Check recurring charges: ${subs.map((s) => s.title.replace(' looks like a monthly bill', '')).join(', ')}. Cancel what you don't use.`);
    lines.push('Tip: set a budget on your top two flexible categories, and they\'ll be set aside in safe-to-spend automatically.');
    return lines.join('\n\n');
  }

  if (/goal|reach|target|saving for/.test(q)) {
    if (!c.goals.length) return 'You have no goals yet. Add one under **Goals** (an emergency fund, a trip, a laptop) and I\'ll project when you\'ll reach it.';
    const named = c.goals.find((g) => q.includes(g.name.toLowerCase()));
    const list = named ? [named] : c.goals;
    return list.map((g) => {
      const head = `**${g.icon ?? '🎯'} ${g.name}**: ${r(g.saved)} of ${r(g.target)} (${Math.round(g.progress * 100)}%).`;
      if (g.done) return `${head} Done! 🎉`;
      const when = g.reachOn ? `At your pace of ${r(g.pacePerMonth)}/month you'll reach it around **${day(g.reachOn)}**.` : 'Nothing added in the last 3 months, so there\'s no finish date yet. Boost it to get one.';
      const need = g.neededPerMonth ? ` To finish by ${day(g.targetDate!)}, put in ${r(g.neededPerMonth)}/month.` : '';
      return `${head} ${when}${need}`;
    }).join('\n\n');
  }

  if (/budget/.test(q)) {
    const b = c.cats.filter((x) => x.budget !== null);
    if (!b.length) return 'No budgets set yet. Open the **Budget Planner** to add some.';
    return 'This month\'s budgets:\n' + b.map((x) => {
      const proj = c.elapsed ? (x.amount / c.elapsed) * c.totalDays : x.amount;
      const st = x.amount > x.budget! ? '🔴 over' : proj > x.budget! * 1.05 ? '🟠 behind' : '🟢 on track';
      return `• ${x.name}: ${r(x.amount)} of ${r(x.budget!)}, ${st}`;
    }).join('\n');
  }

  if (/bill|due|upcoming|sip|emi|rent|subscription/.test(q)) {
    if (!c.bills.items.length) return 'Nothing left to pay this month from your recurring bills. Add rent, SIPs and subscriptions under **Bills** so I can track them.';
    return `Still to pay this month: **${r(c.bills.total)}**\n` + c.bills.items.slice(0, 8).map((b) => `• ${b.name}: ${r(b.amount)} on ${day(b.date)}${b.overdue ? ' (overdue)' : ''}`).join('\n');
  }

  if (/net ?worth|how much (money )?do i have|balance|wealth/.test(q)) {
    return `Net worth: **${r(c.nw.netWorth)}**. You own ${r(c.nw.assets)} and owe ${r(c.nw.liabilities)}.\n` +
      c.nw.accounts.filter((a) => a.balance !== 0).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)).slice(0, 6).map((a) => `• ${a.name}: ${a.balance < 0 ? '−' : ''}${r(a.balance)}`).join('\n');
  }

  if (/health|score|how am i doing|doing financially/.test(q)) {
    return `Your financial health score is **${c.health.score}/100 (${c.health.label})**.\n` + c.health.parts.map((p) => `• ${p.label}: ${p.score}/100. ${p.detail}`).join('\n') +
      (c.health.focus ? `\n\nBiggest win: ${c.health.focus.tip}` : '');
  }

  const onWhat = q.match(/(?:spen[dt]|spending|paid|pay)\s+(?:on|for|at)\s+([a-z &]+?)(?:\s+(?:this|last|in)\b|\?|$)/);
  const thing = onWhat?.[1]?.trim();
  if (thing) {
    const cat = c.cats.find((x) => x.name.toLowerCase().includes(thing));
    if (cat) return `**${cat.name}**: ${r(cat.amount)} this month so far${cat.previous !== null ? `, vs ${r(cat.previous)} by this point last month` : ''}${cat.avg3 ? `. A usual month is ${r(cat.avg3)}` : ''}.`;
    const mer = c.merchants.find((m: any) => m.name.toLowerCase().includes(thing));
    if (mer) return `**${(mer as any).name}**: ${r((mer as any).amount)} across ${(mer as any).count} payment(s) this month.`;
    return `I couldn't find "${thing}" this month. Try a category name like Food or Transport.`;
  }

  return [
    `This month so far: **${r(c.sum.spent)}** spent${c.sum.earned ? `, ${r(c.sum.earned)} earned` : ''}; **${r(sts)}** is safe to spend.`,
    'I can answer things like:\n• Can I afford a ₹60,000 laptop?\n• How can I save more each month?\n• Why did my spending increase?\n• When will I reach my goal?\n• How much did I spend on food?\n• What bills are due?',
  ].join('\n\n');
}

// ---------- Claude engine ----------
const INSTRUCTIONS = `You are the money copilot inside Paisa OS, a personal finance app for one person in India. You have a snapshot of their month below and tools that read their full records: every transaction, spending for any period, account balances, investments and FDs, loans and debts, bills/subscriptions/mandates, salary and goals.

How to work:
- Look things up rather than guess. If the snapshot doesn't answer the question, call the tools (several in one turn when they're independent). For comparisons, fetch each period. Dates are inclusive and in IST; "this month" follows the snapshot's month range.
- Do the arithmetic yourself from tool results: averages, projections, what-ifs ("if I cut food by 20%", "if I prepay ₹1L on the loan", "can I afford X by June"). State assumptions briefly.
- When asked to add, log or record something, call draft_transaction. It only prepares a card the owner reviews; say "I've drafted it below, tap Review & add". Never claim something was saved.
- Answer in plain language: lead with the answer and the key figure in **bold**, then a few "• " bullets with supporting numbers and one or two concrete next steps. Use Indian number formatting (₹1,23,456). Usually under 180 words; longer only for a requested plan or breakdown. No tables, no headings, no markdown other than **bold** and "• ".
- Only state numbers that come from the snapshot or tools. If data is missing (e.g. no holdings synced), say what to add.
- This is general guidance, not regulated financial or tax advice; for specific product or tax filings, suggest a qualified advisor.`;

export const copilotMode = () => (process.env.ANTHROPIC_API_KEY ? 'claude' : 'local') as 'claude' | 'local';
const MAX_STEPS = 8;

export async function answer(sql: Sql, bookId: string, monthStartDay: number, question: string, history: { role: 'user' | 'assistant'; content: string }[]) {
  const ctx = await buildContext(sql, bookId, monthStartDay);
  const local = () => ({ answer: localAnswer(question, ctx), engine: 'local' as const, drafts: [] as Draft[], looked: [] as string[] });
  if (copilotMode() === 'local') return local();
  const drafts: Draft[] = [];
  const looked: string[] = [];
  try {
    const client = new Anthropic();
    const messages: Anthropic.Beta.BetaMessageParam[] = [...history.slice(-8), { role: 'user', content: question }];
    const system: Anthropic.Beta.BetaTextBlockParam[] = [
      { type: 'text', text: INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `Today: ${ctx.today}. Financial snapshot (JSON, rupees):\n${JSON.stringify(contextForModel(ctx))}` },
    ];
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await client.beta.messages.create({
        model: process.env.COPILOT_MODEL || 'claude-opus-5-5',
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        tools: TOOLS,
        system,
        messages,
      });
      if (response.stop_reason === 'refusal') return local();
      if (response.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: response.content }); continue; }
      const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || !uses.length) {
        const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
        return text ? { answer: text, engine: 'claude' as const, drafts, looked } : local();
      }
      messages.push({ role: 'assistant', content: response.content });
      const results = await Promise.all(uses.map(async (u): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        looked.push(u.name);
        try {
          const out = await runTool(sql, bookId, u.name, u.input, drafts);
          return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) };
        } catch (e: any) {
          console.error(`Copilot tool ${u.name} failed`, e);
          return { type: 'tool_result', tool_use_id: u.id, content: 'That lookup failed on the server.', is_error: true };
        }
      }));
      messages.push({ role: 'user', content: results });
    }
    return { answer: "That needed more lookups than I'm allowed in one go. Try asking a narrower question (one period or one category at a time).", engine: 'claude' as const, drafts, looked };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) console.error('Copilot: ANTHROPIC_API_KEY was rejected; using the local engine.');
    else if (e instanceof Anthropic.RateLimitError) console.error('Copilot: rate limited; using the local engine.');
    else if (e instanceof Anthropic.APIError) console.error(`Copilot: API error ${e.status}; using the local engine.`);
    else console.error('Copilot: unexpected error; using the local engine.', e);
    return local();
  }
}
