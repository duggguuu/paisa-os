/**
 * India income tax, New Regime (section 115BAC), FY 2025-26 and FY 2026-27 (Budget 2026 left it unchanged).
 * All amounts are in RUPEES here (not paise).
 *
 *  - Standard deduction ₹75,000 on salary.
 *  - Employer's NPS contribution (80CCD(2)) deductible up to 14% of basic + DA.
 *  - Slabs: 0–4L nil · 4–8L 5% · 8–12L 10% · 12–16L 15% · 16–20L 20% · 20–24L 25% · above 24L 30%.
 *  - 87A rebate: no tax if taxable income ≤ ₹12L; just above it, tax is capped at the income above ₹12L (marginal relief).
 *  - Surcharge: 10% above ₹50L, 15% above ₹1Cr, 25% above ₹2Cr (capped at 25% in the new regime), with marginal relief.
 *  - Health & education cess 4%.
 * Not modelled: special-rate income (capital gains, lottery), agricultural income, the old regime.
 */
export const NEW_REGIME = {
  label: 'New Regime · FY 2026-27',
  standardDeduction: 75_000,
  employerNpsCap: 0.14,
  slabs: [
    [4_00_000, 0], [8_00_000, 0.05], [12_00_000, 0.10], [16_00_000, 0.15],
    [20_00_000, 0.20], [24_00_000, 0.25], [Infinity, 0.30],
  ] as [number, number][],
  rebateLimit: 12_00_000,
  surcharge: [[50_00_000, 0.10], [1_00_00_000, 0.15], [2_00_00_000, 0.25]] as [number, number][],
  cess: 0.04,
};

export interface Band { from: number; to: number; rate: number; tax: number }

export function slabTax(income: number) {
  let prev = 0, tax = 0;
  const bands: Band[] = [];
  for (const [upto, rate] of NEW_REGIME.slabs) {
    if (income <= prev) break;
    const slice = Math.min(income, upto) - prev;
    const t = slice * rate;
    bands.push({ from: prev, to: Math.min(income, upto), rate, tax: t });
    tax += t;
    prev = upto;
  }
  return { tax, bands };
}

/** Tax after rebate, before surcharge and cess. */
function afterRebate(taxable: number) {
  const { tax } = slabTax(taxable);
  if (taxable <= NEW_REGIME.rebateLimit) return 0;
  return Math.min(tax, taxable - NEW_REGIME.rebateLimit); // marginal relief just above ₹12L
}

/** Tax + surcharge (with marginal relief at each threshold). */
function withSurcharge(taxable: number) {
  const base = afterRebate(taxable);
  let rate = 0, threshold = 0;
  for (const [t, r] of NEW_REGIME.surcharge) if (taxable > t) { rate = r; threshold = t; }
  if (!rate) return { tax: base, surcharge: 0 };
  let surcharge = base * rate;
  const atThreshold = withSurcharge(threshold);
  const cap = atThreshold.tax + atThreshold.surcharge + (taxable - threshold);
  if (base + surcharge > cap) surcharge = Math.max(0, cap - base);
  return { tax: base, surcharge };
}

export interface TaxInput {
  salary: number;           // gross salary for the year (incl. bonus), before any deduction
  basicDa?: number;         // basic + DA for the year (caps the employer-NPS deduction)
  employerNps?: number;     // employer's NPS contribution for the year
  otherIncome?: number;     // interest, etc. (taxed at slab rates)
}

export function newRegimeTax(i: TaxInput) {
  const std = Math.min(NEW_REGIME.standardDeduction, Math.max(i.salary, 0));
  const nps = Math.floor(Math.min(i.employerNps ?? 0, NEW_REGIME.employerNpsCap * (i.basicDa ?? 0)));
  const gross = Math.max(i.salary, 0) + Math.max(i.otherIncome ?? 0, 0);
  const taxable = Math.max(0, Math.floor((gross - std - nps) / 10) * 10); // rounded down to ₹10 (sec 288A)
  const slab = slabTax(taxable);
  const { tax, surcharge } = withSurcharge(taxable);
  const rebate = slab.tax - tax;
  const cess = (tax + surcharge) * NEW_REGIME.cess;
  const total = Math.round((tax + surcharge + cess) / 10) * 10;   // rounded to ₹10 (sec 288B)
  return {
    gross, standardDeduction: std, employerNps: nps, taxable,
    bands: slab.bands, slabTax: slab.tax, rebate, surcharge, cess, total,
    effectiveRate: gross > 0 ? total / gross : 0,
    marginalRate: slabRateAt(taxable),
  };
}

function slabRateAt(taxable: number) {
  if (taxable <= NEW_REGIME.rebateLimit) return 0;
  for (const [upto, rate] of NEW_REGIME.slabs) if (taxable <= upto) return rate;
  return 0.3;
}
