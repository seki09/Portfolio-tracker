#!/usr/bin/env node
// Independent audit of the portfolio snapshot.
//
// Everything here is recomputed from the raw Parqet payloads with code that is
// deliberately NOT shared with tools/parqet-import/convert.mjs — only the
// snapshot's output schema is used. See README.md for what is checked and why.
//
// This file contains no personal data. It reads gitignored inputs at runtime.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

// ---------------------------------------------------------------------------
// Tolerances
// ---------------------------------------------------------------------------
export const TOL = {
  shares: 1e-6, //          shares (raw data has ≤ 6 decimals)
  money: 0.01, //           EUR, one value vs one value (snapshot rounds to cents)
  moneyPerTerm: 0.005, //   EUR, added per rounded summand when comparing sums
  pct: 0.01, //             percentage points for XIRR / TTWROR copies
  ttwrorSanity: 0.25, //    percentage points, TTWROR rebuilt from a daily series (WARN only)
  staleDays: 3, //          calendar days before quotes / snapshot are considered stale
};
const sumTol = (n) => Math.max(TOL.money, TOL.moneyPerTerm * n);

// Shares are tracked as integers of 1e-8 so splits and partial sells never
// accumulate binary-float drift. Money is kept unrounded (as Parqet does) and
// only compared with the tolerances above.
const UNIT = 1e8;
export const toUnits = (shares) => Math.round(Number(shares) * UNIT);
export const fromUnits = (units) => units / UNIT;

// Parqet's calendar day is the UTC date of the activity timestamp. Verified on
// real data: XIRR computed on UTC days matches Parqet to <1e-4 pp, while
// Europe/Vienna local days are off by ~6e-3 pp.
export const dayOf = (iso) => String(iso).slice(0, 10);
const DAY_MS = 86400000;
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY_MS;

const INFLOW = new Set(['buy', 'transfer_in']);
const OUTFLOW = new Set(['sell', 'transfer_out']);
export const KNOWN_TYPES = new Set([
  'buy', 'sell', 'dividend', 'interest', 'transfer_in', 'transfer_out',
  'fees_taxes', 'deposit', 'withdrawal',
]);

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** portfolio id of a raw activity / holding: explicit field, else the
 *  `<portfolioId>::<sub>` prefix of subAccount, else the payload's id. */
export function portfolioOf(row, fallback = null) {
  if (row.portfolioId) return row.portfolioId;
  if (typeof row.subAccount === 'string' && row.subAccount.includes('::')) return row.subAccount.split('::')[0];
  return fallback ?? 'default';
}

/** Accepts any of: {portfolioId, activities:[…]}, [payload, payload], [activity, …].
 *  Returns {activities, incomplete:[…], duplicates} with activities normalised. */
export function normalizeActivities(payloads) {
  const list = [];
  const incomplete = [];
  const visit = (p, fallbackPid) => {
    if (Array.isArray(p)) { for (const x of p) visit(x, fallbackPid); return; }
    if (p && Array.isArray(p.activities)) {
      const pid = p.portfolioId ?? fallbackPid;
      if (p.cursor) incomplete.push({ portfolioId: pid, reason: 'cursor not exhausted' });
      if (Number.isFinite(p.totalActivities) && p.totalActivities !== p.activities.length)
        incomplete.push({ portfolioId: pid, reason: `${p.activities.length}/${p.totalActivities} rows` });
      for (const a of p.activities) list.push({ a, pid });
      return;
    }
    if (p && p.type) list.push({ a: p, pid: fallbackPid });
  };
  for (const { data, portfolioId } of payloads) visit(data, portfolioId);

  const seen = new Set();
  let duplicates = 0;
  const activities = [];
  for (const { a, pid } of list) {
    if (a.id && seen.has(a.id)) { duplicates++; continue; }
    if (a.id) seen.add(a.id);
    const fee = Number(a.fee ?? 0);
    const tax = Number(a.tax ?? 0);
    const shares = Number(a.shares ?? 0);
    const price = Number(a.price ?? 0);
    const amount = a.amount != null ? Number(a.amount) : shares * price;
    // amountNet per the documented rule if missing: buy = amount + fee + tax,
    // everything else = amount − fee − tax (a negative tax is a refund).
    const amountNet = a.amountNet != null ? Number(a.amountNet)
      : INFLOW.has(a.type) ? amount + fee + tax : amount - fee - tax;
    const portfolioId = portfolioOf(a, pid);
    activities.push({
      id: a.id ?? null,
      type: a.type,
      portfolioId,
      holdingId: a.holdingId ?? null,
      isin: a.asset?.isin ?? a.isin ?? null,
      key: `${portfolioId}|${a.holdingId ?? a.asset?.isin ?? a.isin ?? 'cash'}`,
      datetime: a.datetime,
      date: dayOf(a.datetime),
      shares, price, amount, fee, tax, amountNet,
      currency: a.currency ?? null,
      fx: a.fx ?? null,
      parqet: a.realizedGains != null || a.buyAmountNet != null
        ? { realizedGains: a.realizedGains, realizedGainsNet: a.realizedGainsNet, buyAmountNet: a.buyAmountNet }
        : null,
    });
  }
  return { activities, incomplete, duplicates };
}

/** Splits table → Map isin → [{exDate, ratio}] sorted by exDate. */
export function splitIndex(splits) {
  const m = new Map();
  for (const s of splits ?? []) {
    if (!s.isin || !s.exDate || !(s.ratio > 0)) continue;
    if (!m.has(s.isin)) m.set(s.isin, []);
    m.get(s.isin).push({ exDate: s.exDate, ratio: Number(s.ratio) });
  }
  for (const v of m.values()) v.sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
  return m;
}

// ---------------------------------------------------------------------------
// Position rebuild (FIFO + moving average, splits applied on ex-date)
// ---------------------------------------------------------------------------

function emptyPosition(a) {
  return {
    key: a.key, portfolioId: a.portfolioId, holdingId: a.holdingId, isin: a.isin,
    units: 0,
    lots: [], //               FIFO lots: {date, units, cost (fees excl.), fee}
    avgUnits: 0, avgCost: 0, // moving average, fees excluded (Austrian KESt basis)
    realizedGross: 0, realizedNet: 0,
    buyFees: 0, sellFees: 0, sellTaxes: 0,
    dividends: { gross: 0, net: 0, tax: 0, fee: 0, count: 0 },
    interest: { gross: 0, net: 0, tax: 0, fee: 0, count: 0 },
    splitsApplied: [],
    sells: [], //               per-sell results for comparison with Parqet's own fields
    warnings: [],
    trades: 0, first: null, last: null,
  };
}

/** Take `units` out of the FIFO queue; returns {cost, fee, taken}. */
function takeFifo(pos, units) {
  let left = units, cost = 0, fee = 0;
  while (left > 0 && pos.lots.length) {
    const lot = pos.lots[0];
    const take = Math.min(left, lot.units);
    const share = take / lot.units;
    const c = lot.cost * share, f = lot.fee * share;
    cost += c; fee += f;
    lot.cost -= c; lot.fee -= f; lot.units -= take;
    left -= take;
    if (lot.units === 0) pos.lots.shift();
  }
  return { cost, fee, taken: units - left };
}

function takeAverage(pos, units) {
  if (pos.avgUnits <= 0) return 0;
  const take = Math.min(units, pos.avgUnits);
  const cost = pos.avgCost * (take / pos.avgUnits);
  pos.avgCost -= cost;
  pos.avgUnits -= take;
  if (pos.avgUnits === 0) pos.avgCost = 0;
  return cost;
}

function applySplit(pos, split) {
  if (pos.units === 0 && pos.lots.length === 0) return;
  const r = split.ratio;
  for (const lot of pos.lots) lot.units = Math.round(lot.units * r);
  pos.units = pos.lots.reduce((s, l) => s + l.units, 0);
  pos.avgUnits = Math.round(pos.avgUnits * r);
  pos.splitsApplied.push({ exDate: split.exDate, ratio: r });
}

const ORDER = { buy: 0, transfer_in: 0, dividend: 1, interest: 1, fees_taxes: 1, sell: 2, transfer_out: 2 };

/** Rebuild every holding from raw activities. Returns Map key → position. */
export function rebuildPositions(activities, splits) {
  const idx = splits instanceof Map ? splits : splitIndex(splits);
  const groups = new Map();
  for (const a of activities) {
    if (!groups.has(a.key)) groups.set(a.key, []);
    groups.get(a.key).push(a);
  }
  const out = new Map();
  for (const [key, acts] of groups) {
    acts.sort((x, y) => (x.datetime < y.datetime ? -1 : x.datetime > y.datetime ? 1
      : (ORDER[x.type] ?? 1) - (ORDER[y.type] ?? 1)));
    const pos = emptyPosition(acts[0]);
    const sp = idx.get(pos.isin) ?? [];
    let si = 0;
    for (const a of acts) {
      while (si < sp.length && sp[si].exDate <= a.date) applySplit(pos, sp[si++]);
      if (!KNOWN_TYPES.has(a.type)) { pos.warnings.push(`unknown activity type ${a.type}`); continue; }
      if (a.type === 'buy' || a.type === 'transfer_in') {
        const u = toUnits(a.shares);
        pos.lots.push({ date: a.date, units: u, cost: a.amount, fee: a.fee + a.tax, price: a.price });
        pos.units += u;
        pos.avgUnits += u; pos.avgCost += a.amount;
        if (a.type === 'buy') pos.buyFees += a.fee;
      } else if (a.type === 'sell' || a.type === 'transfer_out') {
        const u = toUnits(a.shares);
        if (u > pos.units) pos.warnings.push(`${a.date}: ${a.type} of ${a.shares} exceeds held ${fromUnits(pos.units)} (missing split?)`);
        const { cost, fee } = takeFifo(pos, u);
        takeAverage(pos, u);
        pos.units = pos.lots.reduce((s, l) => s + l.units, 0);
        if (a.type === 'sell') {
          const realizedGross = a.amount - cost;
          // Parqet's realised NET = sell amountNet − (FIFO cost + the sold lots'
          // pro-rata buy fees). Established from the raw data: each sell row
          // carries buyAmountNet and realizedGainsNet = amountNet − buyAmountNet.
          const realizedNet = a.amountNet - (cost + fee);
          pos.realizedGross += realizedGross;
          pos.realizedNet += realizedNet;
          pos.sellFees += a.fee; pos.sellTaxes += a.tax;
          pos.sells.push({ date: a.date, id: a.id, realizedGross, realizedNet, buyAmountNet: cost + fee, parqet: a.parqet });
        }
      } else if (a.type === 'dividend' || a.type === 'interest') {
        const d = a.type === 'dividend' ? pos.dividends : pos.interest;
        d.gross += a.amount; d.net += a.amountNet; d.tax += a.tax; d.fee += a.fee; d.count++;
      }
      if (a.type === 'buy' || a.type === 'sell') {
        pos.trades++;
        pos.first ??= a.date;
        pos.last = a.date;
      }
    }
    // splits after the last activity still apply to what is held today
    while (si < sp.length) applySplit(pos, sp[si++]);
    out.set(key, finish(pos));
  }
  return out;
}

function finish(pos) {
  const fifoCost = pos.lots.reduce((s, l) => s + l.cost, 0);
  const fifoFees = pos.lots.reduce((s, l) => s + l.fee, 0);
  return {
    ...pos,
    shares: fromUnits(pos.units),
    fifoCost, fifoFees,
    avgCostAustria: pos.avgCost,
    lots: pos.lots.map((l) => ({
      date: l.date, shares: fromUnits(l.units), cost: l.cost, fee: l.fee,
      price: l.units ? l.cost / fromUnits(l.units) : 0, portfolioId: pos.portfolioId,
    })),
  };
}

/** Sum per-holding positions to one position per ISIN (several portfolios). */
export function combineByIsin(positions) {
  const m = new Map();
  for (const p of positions.values()) {
    if (!p.isin) continue;
    if (!m.has(p.isin)) m.set(p.isin, {
      isin: p.isin, shares: 0, units: 0, fifoCost: 0, fifoFees: 0, avgCostAustria: 0,
      realizedGross: 0, realizedNet: 0, buyFees: 0,
      dividends: { gross: 0, net: 0, tax: 0, fee: 0, count: 0 },
      lots: [], parts: [],
    });
    const c = m.get(p.isin);
    c.units += p.units; c.shares = fromUnits(c.units);
    c.fifoCost += p.fifoCost; c.fifoFees += p.fifoFees;
    // KESt basis is kept per depot; the combined figure is the sum of depots.
    c.avgCostAustria += p.avgCostAustria;
    c.realizedGross += p.realizedGross; c.realizedNet += p.realizedNet; c.buyFees += p.buyFees;
    for (const k of Object.keys(c.dividends)) c.dividends[k] += p.dividends[k];
    c.lots.push(...p.lots);
    c.parts.push(p);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

/** Cash flows as Parqet defines them for XIRR (established from real data,
 *  match < 1e-4 pp): investor's view, net amounts, UTC day, ACT/365:
 *    buy / transfer_in → −amountNet;  sell / dividend / interest / transfer_out → +amountNet
 *    fees_taxes → −|amountNet|;  terminal value → +value on the end date.
 *  deposit / withdrawal only move cash inside the account and are not flows here. */
export function investorFlows(activities, terminal) {
  const flows = [];
  for (const a of activities) {
    let v = null;
    if (INFLOW.has(a.type)) v = -a.amountNet;
    else if (OUTFLOW.has(a.type) || a.type === 'dividend' || a.type === 'interest') v = a.amountNet;
    else if (a.type === 'fees_taxes') v = -Math.abs(a.amountNet);
    if (v != null && v !== 0) flows.push({ date: a.date, amount: v });
  }
  if (terminal) flows.push({ date: terminal.date, amount: terminal.value });
  return flows.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

/** NPV at annual rate r with ACT/365 from the first flow date. */
export function xnpv(r, flows) {
  const t0 = flows[0].date;
  let s = 0;
  for (const f of flows) s += f.amount / Math.pow(1 + r, daysBetween(t0, f.date) / 365);
  return s;
}

function dxnpv(r, flows) {
  const t0 = flows[0].date;
  let s = 0;
  for (const f of flows) {
    const t = daysBetween(t0, f.date) / 365;
    s -= (t * f.amount) / Math.pow(1 + r, t + 1);
  }
  return s;
}

/** XIRR as a fraction (0.1 = 10 %). Newton first, bisection if Newton fails or
 *  `opts.method === 'bisection'`. Returns {rate, method, iterations} or null. */
export function xirr(flows, opts = {}) {
  if (!flows.length || !flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return null;
  const sorted = [...flows].sort((x, y) => (x.date < y.date ? -1 : 1));
  const eps = opts.eps ?? 1e-10;
  if (opts.method !== 'bisection') {
    let r = opts.guess ?? 0.1;
    for (let i = 1; i <= 100; i++) {
      const f = xnpv(r, sorted), d = dxnpv(r, sorted);
      if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
      const next = r - f / d;
      if (!Number.isFinite(next) || next <= -1) break;
      if (Math.abs(next - r) < eps) return { rate: next, method: 'newton', iterations: i };
      r = next;
    }
  }
  let lo = -0.999999, hi = 1;
  const flo = xnpv(lo, sorted);
  let fhi = xnpv(hi, sorted);
  while (Math.sign(fhi) === Math.sign(flo) && hi < 1e6) { hi *= 2; fhi = xnpv(hi, sorted); }
  if (Math.sign(fhi) === Math.sign(flo)) return null;
  let i = 0;
  for (; i < 300 && hi - lo > eps; i++) {
    const mid = (lo + hi) / 2;
    const fm = xnpv(mid, sorted);
    if (Math.sign(fm) === Math.sign(flo)) lo = mid; else hi = mid;
  }
  return { rate: (lo + hi) / 2, method: 'bisection', iterations: i };
}

/** True time-weighted return (%) over a value series with external flows.
 *  points: [{date, value}] sorted; flows: Map date → net inflow (buy +, sell/dividend −).
 *  Flows dated in (prev, cur] are assumed at the END of the period:
 *    r = (V_cur − F) / V_prev.
 *  Only meaningful when the series is daily; returns {pct, periods} or {reason}. */
export function ttwror(points, flowsByDate) {
  if (points.length < 2) return { reason: 'fewer than two points' };
  const dates = [...flowsByDate.keys()].sort();
  let growth = 1, j = 0, periods = 0;
  while (j < dates.length && dates[j] <= points[0].date) j++;
  for (let i = 1; i < points.length; i++) {
    let f = 0;
    while (j < dates.length && dates[j] <= points[i].date) f += flowsByDate.get(dates[j++]);
    const prev = points[i - 1].value;
    if (!(prev > 0)) return { reason: `non-positive base value on ${points[i - 1].date}` };
    growth *= (points[i].value - f) / prev;
    periods++;
  }
  return { pct: (growth - 1) * 100, periods };
}

/** Net external inflow per UTC day (buy +amountNet, sell/dividend −amountNet). */
export function flowsByDay(activities) {
  const m = new Map();
  for (const f of investorFlows(activities, null)) m.set(f.date, (m.get(f.date) ?? 0) - f.amount);
  return m;
}

// ---------------------------------------------------------------------------
// Loading (runtime only — nothing here is committed)
// ---------------------------------------------------------------------------

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function loadRaw(dir) {
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const pick = (re) => files.filter((f) => re.test(f)).sort();
  const actPayloads = pick(/^activities(-[^.]+)?\.json$/).map((f) => ({
    file: f, data: readJSON(join(dir, f)), portfolioId: f.match(/^activities-([^.]+)\.json$/)?.[1] ?? null,
  }));
  const perfFiles = pick(/^performance(-[^.]+)?\.json$/);
  const performance = perfFiles.includes('performance.json') ? readJSON(join(dir, 'performance.json')) : null;
  const perfByPortfolio = new Map();
  for (const f of perfFiles) {
    const m = f.match(/^performance-([^.]+)\.json$/);
    if (m) perfByPortfolio.set(m[1], readJSON(join(dir, f)));
  }
  const opt = (f) => (files.includes(f) ? readJSON(join(dir, f)) : null);
  const names = new Map();
  const pf = opt('portfolios.json');
  for (const p of Array.isArray(pf) ? pf : pf?.portfolios ?? []) if (p?.id) names.set(p.id, p.name ?? p.id);
  const one = opt('portfolio.json');
  if (one?.id && !names.has(one.id)) names.set(one.id, one.name ?? one.id);
  return {
    dir, actPayloads, performance, perfByPortfolio, names,
    charts: opt('overview-charts.json'), ranges: opt('ranges.json'), day: opt('day.json'),
  };
}

export function loadSnapshot(file) {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(file, 'utf8'), ctx, { filename: basename(file) });
  return ctx.window.PORTFOLIO;
}

/** Every Parqet holding from all performance payloads, deduplicated by id. */
export function parqetHoldings(raw) {
  const m = new Map();
  const add = (p, pid) => {
    for (const h of p?.holdings ?? []) {
      if (m.has(h.id)) continue;
      const portfolioId = portfolioOf(h, pid);
      m.set(h.id, { ...h, portfolioId, key: `${portfolioId}|${h.id}` });
    }
  };
  add(raw.performance, null);
  for (const [pid, p] of raw.perfByPortfolio) add(p, pid);
  return m;
}

// ---------------------------------------------------------------------------
// Check plumbing
// ---------------------------------------------------------------------------

export class Report {
  constructor() { this.rows = []; }
  add(status, group, name, detail = '', items = []) { this.rows.push({ status, group, name, detail, items }); }
  /** compare many items; each item {label, ours, theirs, tol} */
  compare(group, name, items, { warnOnly = false, note = '' } = {}) {
    if (!items.length) return this.add('SKIP', group, name, note || 'nothing to compare');
    const bad = items.filter((i) => !(Math.abs((i.ours ?? NaN) - (i.theirs ?? NaN)) <= i.tol));
    const max = Math.max(...items.map((i) => Math.abs((i.ours ?? NaN) - (i.theirs ?? NaN))).filter(Number.isFinite), 0);
    const status = bad.length ? (warnOnly ? 'WARN' : 'FAIL') : 'PASS';
    const detail = `${items.length - bad.length}/${items.length} within tol, max |Δ| ${fmt(max)}${note ? ` — ${note}` : ''}`;
    this.add(status, group, name, detail, bad.map((i) => `${i.label}: Δ ${fmt((i.ours ?? NaN) - (i.theirs ?? NaN))}`));
  }
  get failed() { return this.rows.some((r) => r.status === 'FAIL'); }
}

const fmt = (x) => (Number.isFinite(x) ? (Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(2)) : String(x));
const sum = (xs, f = (x) => x) => xs.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const item = (label, ours, theirs, tol = TOL.money) => ({ label, ours, theirs, tol });

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

export function runAudit({ raw, snapshot, splits, now = new Date() }) {
  const R = new Report();
  const S = snapshot;
  const { activities, incomplete, duplicates } = normalizeActivities(raw.actPayloads);
  const pids = [...new Set(activities.map((a) => a.portfolioId))];
  const names = new Map(raw.names);
  for (const acc of S?.meta?.portfolio?.accounts ?? []) if (acc.id) names.set(acc.id, acc.name);
  if (S?.meta?.portfolio?.id && !names.has(S.meta.portfolio.id)) names.set(S.meta.portfolio.id, S.meta.portfolio.name);
  const nameOf = (pid) => names.get(pid) ?? pid;

  // ---- Inputs ------------------------------------------------------------
  R.add(activities.length ? 'PASS' : 'FAIL', 'Inputs', 'Raw activities loaded',
    `${activities.length} activities, ${pids.length} portfolio(s), ${raw.actPayloads.length} file(s), ${duplicates} duplicate(s) dropped`);
  R.add(incomplete.length ? 'FAIL' : 'PASS', 'Inputs', 'Activity pages complete',
    incomplete.length ? `${incomplete.length} incomplete payload(s)` : 'cursor exhausted, totals match', incomplete.map((i) => `${nameOf(i.portfolioId)}: ${i.reason}`));
  const unknown = activities.filter((a) => !KNOWN_TYPES.has(a.type));
  const fx = activities.filter((a) => a.fx);
  const cashMoves = activities.filter((a) => a.type === 'deposit' || a.type === 'withdrawal');
  R.add(unknown.length ? 'FAIL' : fx.length || cashMoves.length ? 'WARN' : 'PASS', 'Inputs', 'Activity types / currency',
    `${unknown.length} unknown type(s), ${fx.length} with fx, ${cashMoves.length} deposit/withdrawal (excluded from XIRR flows)`);

  const positions = rebuildPositions(activities, splits);
  const combined = combineByIsin(positions);
  const ph = parqetHoldings(raw);
  const warnings = [...positions.values()].flatMap((p) => p.warnings.map((w) => `${p.isin} @ ${nameOf(p.portfolioId)}: ${w}`));
  R.add(warnings.length ? 'FAIL' : 'PASS', 'Positions', 'Rebuild consistent (no oversell)', `${warnings.length} warning(s)`, warnings);

  // ---- Positions -----------------------------------------------------------
  const phList = [...ph.values()];
  const missing = phList.filter((h) => !positions.has(h.key) && h.position.shares !== 0);
  if (missing.length) R.add('FAIL', 'Positions', 'Every Parqet holding has activities', `${missing.length} without activities`, missing.map((h) => h.asset?.isin));
  R.compare('Positions', 'Shares per holding: rebuilt vs Parqet', phList.map((h) =>
    item(`${h.asset?.isin} @ ${nameOf(h.portfolioId)}`, positions.get(h.key)?.shares ?? 0, h.position.shares, TOL.shares)));

  const parqetByIsin = new Map();
  for (const h of phList) {
    const isin = h.asset?.isin;
    if (!parqetByIsin.has(isin)) parqetByIsin.set(isin, { shares: 0, purchaseValue: 0, currentValue: 0, n: 0 });
    const c = parqetByIsin.get(isin);
    c.shares += h.position.shares; c.purchaseValue += h.position.purchaseValue; c.currentValue += h.position.currentValue; c.n++;
  }
  R.compare('Positions', 'Shares per ISIN (all portfolios): rebuilt vs Parqet', [...parqetByIsin].map(([isin, p]) =>
    item(isin, combined.get(isin)?.shares ?? 0, p.shares, TOL.shares)));

  const snapByIsin = new Map();
  for (const h of S?.holdings ?? []) {
    if (!snapByIsin.has(h.isin)) snapByIsin.set(h.isin, []);
    snapByIsin.get(h.isin).push(h);
  }
  const snapSum = (isin, f) => sum(snapByIsin.get(isin) ?? [], f);
  const openIsins = [...combined.values()].filter((c) => c.units !== 0).map((c) => c.isin);
  const allIsins = [...new Set([...openIsins, ...snapByIsin.keys()])];
  R.compare('Positions', 'Shares per ISIN: rebuilt vs snapshot', allIsins.map((isin) =>
    item(isin, combined.get(isin)?.shares ?? 0, snapSum(isin, (h) => h.shares), TOL.shares)));

  const accItems = [];
  const accCost = [];
  for (const [isin, list] of snapByIsin) for (const h of list) for (const acc of h.accounts ?? []) {
    const p = (combined.get(isin)?.parts ?? []).filter((x) => nameOf(x.portfolioId) === acc.name);
    accItems.push(item(`${isin} @ ${acc.name}`, sum(p, (x) => x.shares), acc.shares, TOL.shares));
    if (acc.cost != null) accCost.push(item(`${isin} @ ${acc.name}`, sum(p, (x) => x.fifoCost), acc.cost));
  }
  if (accItems.length) R.compare('Positions', 'Shares per ISIN × portfolio: rebuilt vs snapshot accounts', accItems);
  else R.add('SKIP', 'Positions', 'Shares per ISIN × portfolio', 'snapshot has no holdings[].accounts');

  const splitItems = [];
  for (const isin of openIsins) {
    const ours = combined.get(isin).parts.flatMap((p) => p.splitsApplied).map((s) => `${s.exDate}:${s.ratio}`);
    const theirs = (snapByIsin.get(isin) ?? []).flatMap((h) => h.splits ?? []).map((s) => `${s.exDate}:${s.ratio}`);
    const a = [...new Set(ours)].sort().join(','), b = [...new Set(theirs)].sort().join(',');
    if (a !== b) splitItems.push(`${isin}: rebuilt [${a}] vs snapshot [${b}]`);
  }
  R.add(splitItems.length ? 'FAIL' : 'PASS', 'Positions', 'Splits applied = snapshot holdings[].splits',
    `${openIsins.length - splitItems.length}/${openIsins.length} agree`, splitItems);

  // ---- Cost basis ----------------------------------------------------------
  R.compare('Cost basis', 'FIFO (fees excl.) per holding: rebuilt vs Parqet purchaseValue', phList.map((h) =>
    item(`${h.asset?.isin} @ ${nameOf(h.portfolioId)}`, positions.get(h.key)?.fifoCost ?? 0, h.position.purchaseValue)));
  R.compare('Cost basis', 'FIFO (fees excl.) per ISIN: rebuilt vs snapshot cost', allIsins.map((isin) =>
    item(isin, combined.get(isin)?.fifoCost ?? 0, snapSum(isin, (h) => h.cost))));
  if (accCost.length) R.compare('Cost basis', 'FIFO per ISIN × portfolio: rebuilt vs snapshot accounts', accCost);
  R.compare('Cost basis', 'Moving avg (fees excl.) per ISIN: rebuilt vs snapshot costAustria', allIsins.map((isin) =>
    item(isin, combined.get(isin)?.avgCostAustria ?? 0, snapSum(isin, (h) => h.costAustria))),
  { note: 'KESt basis per depot, summed across depots' });
  R.compare('Cost basis', 'Snapshot avg = cost / shares', (S?.holdings ?? []).filter((h) => h.shares).map((h) =>
    item(h.isin, h.cost / h.shares, h.avg, 0.006)));

  // ---- Lots ----------------------------------------------------------------
  const lotShares = [], lotCost = [], lotMatch = [];
  for (const h of S?.holdings ?? []) {
    const lots = h.lots ?? [];
    lotShares.push(item(h.isin, sum(lots, (l) => l.shares), h.shares, TOL.shares));
    lotCost.push(item(h.isin, sum(lots, (l) => l.cost), h.cost, sumTol(lots.length)));
    const ours = (combined.get(h.isin)?.lots ?? []);
    const key = (date, acct, shares) => `${date}|${acct ?? ''}|${Math.round(shares * 1e6)}`;
    const mine = new Map(ours.map((l) => [key(l.date, h.lots?.[0]?.account ? nameOf(l.portfolioId) : null, l.shares), l]));
    let bad = 0;
    for (const l of lots) {
      const o = mine.get(key(l.date, l.account ?? null, l.shares));
      if (!o || Math.abs(o.cost - l.cost) > TOL.money || (l.fee != null && Math.abs(o.fee - l.fee) > TOL.money)) bad++;
    }
    lotMatch.push(item(h.isin, bad + Math.abs(ours.length - lots.length), 0, 0));
  }
  R.compare('Lots', 'Σ lot shares = holding shares (snapshot)', lotShares);
  R.compare('Lots', 'Σ lot cost = holding cost (snapshot)', lotCost);
  R.compare('Lots', 'Snapshot lots = rebuilt FIFO lots (date, shares, cost, fee)', lotMatch, { note: 'Δ = mismatching lots' });

  // ---- Valuation -----------------------------------------------------------
  const H = S?.holdings ?? [];
  R.compare('Valuation', 'shares × price = value (snapshot)', H.map((h) =>
    item(h.isin, h.shares * h.price, h.value, Math.abs(h.shares) * 0.005 + TOL.money)));
  R.compare('Valuation', 'Value per ISIN: snapshot vs Parqet currentValue', allIsins.map((isin) =>
    item(isin, snapSum(isin, (h) => h.value), parqetByIsin.get(isin)?.currentValue ?? 0)));
  const pv = raw.performance?.performance?.valuation?.atIntervalEnd;
  R.compare('Valuation', 'Σ holdings value = totals.value = Parqet valuation', [
    item('Σ holdings vs totals.value', sum(H, (h) => h.value), S?.totals?.value, sumTol(H.length)),
    ...(pv != null ? [item('totals.value vs Parqet', S?.totals?.value, pv)] : []),
  ]);
  // Definition (agreed after the first audit): unrealised is NET of the buy fees still
  // attached to the open lots — fees come from OUR rebuilt lots, not the snapshot's.
  // value, cost, fees and unrealized are each rounded to cents → up to 4 × 0.005
  R.compare('Valuation', 'unrealized = value − cost − open-lot buy fees (per holding)', H.map((h) =>
    item(h.isin, h.value - h.cost - sum(combined.get(h.isin)?.lots ?? [], (l) => l.fee), h.unrealized, sumTol(4))));
  const ourInvested = sum([...combined.values()], (c) => c.fifoCost);
  R.compare('Valuation', 'Invested = Σ open FIFO cost (rebuilt) vs totals.invested', [item('invested', ourInvested, S?.totals?.invested, sumTol(H.length))],
    { note: "Parqet's capital = Σ purchaseValue of open positions" });

  // Parqet's portfolio-level unrealized NET deducts ALL lifetime buy fees of
  // every still-open holding, including fees of lots already sold — which are
  // also deducted in realised NET. Measure that double count.
  const openFeesOurs = sum([...positions.values()], (p) => p.fifoFees);
  const pu = raw.performance?.performance?.unrealizedGains?.inInterval;
  const parqetOpenFees = pu ? pu.gainGross - pu.gainNet : null;
  if (parqetOpenFees != null) {
    const dbl = parqetOpenFees - openFeesOurs;
    R.add(Math.abs(dbl) <= TOL.money ? 'PASS' : 'WARN', 'Valuation', 'Parqet unrealized gross−net = buy fees of remaining lots',
      Math.abs(dbl) <= TOL.money ? `Δ ${fmt(dbl)}`
        : `Δ ${fmt(dbl)} = buy fees of already-sold lots in still-open holdings, counted in BOTH Parqet realizedNet and unrealizedNet`);
  }
  const unrealSum = sum(H, (h) => h.unrealized);
  R.compare('Valuation', 'totals.unrealized = Σ holdings unrealized', [item('totals', S?.totals?.unrealized, unrealSum, sumTol(H.length))],
    { note: 'rows and total are net of open-lot buy fees' });
  // Ground truth for the headline figure: value now + everything received − everything paid,
  // straight from raw activities (only defined when every activity is a EUR cash event).
  const rawActs = raw.activities ?? [];
  if (rawActs.length && rawActs.every((a) => ['buy', 'sell', 'dividend', 'interest', 'fees_taxes'].includes(a.type) && a.currency === 'EUR')) {
    const flows = sum(rawActs, (a) => (a.type === 'buy' || a.type === 'fees_taxes' ? -a.amountNet : a.amountNet));
    R.compare('Valuation', 'totalGain = value + received − paid (raw cash flows)', [item('totalGain', (pv ?? S?.totals?.value) + flows, S?.totals?.totalGain, 0.05)]);
  }

  // ---- Realised gains & dividends -----------------------------------------
  const sells = [...positions.values()].flatMap((p) => p.sells.map((s) => ({ ...s, isin: p.isin, pid: p.portfolioId })));
  const withParqet = sells.filter((s) => s.parqet);
  if (withParqet.length) {
    R.compare('Realised', 'Per sell: gross / buyAmountNet / net vs Parqet row fields', withParqet.flatMap((s) => [
      item(`${s.isin} ${s.date} gross`, s.realizedGross, s.parqet.realizedGains),
      item(`${s.isin} ${s.date} buyAmountNet`, s.buyAmountNet, s.parqet.buyAmountNet),
      item(`${s.isin} ${s.date} net`, s.realizedNet, s.parqet.realizedGainsNet),
    ]));
  }
  R.compare('Realised', 'Realised per holding (gross & net): rebuilt vs Parqet', phList.flatMap((h) => {
    const p = positions.get(h.key);
    const r = h.performance?.realizedGains?.inInterval ?? {};
    return [item(`${h.asset?.isin} gross`, p?.realizedGross ?? 0, r.gainGross ?? 0), item(`${h.asset?.isin} net`, p?.realizedNet ?? 0, r.gainNet ?? 0)];
  }));
  const ourRG = sum(sells, (s) => s.realizedGross), ourRN = sum(sells, (s) => s.realizedNet);
  const prg = raw.performance?.performance?.realizedGains?.inInterval;
  R.compare('Realised', 'Realised total: rebuilt vs Parqet (gross, net) vs snapshot', [
    ...(prg ? [item('gross vs Parqet', ourRG, prg.gainGross), item('net vs Parqet', ourRN, prg.gainNet)] : []),
    item('net vs snapshot totals.realized', ourRN, S?.totals?.realized),
  ]);
  const realisedSnap = [];
  for (const [isin, c] of combined) {
    const snap = (snapByIsin.get(isin) ?? []).reduce((s, h) => s + (h.realized ?? 0), 0)
      + (S?.closed ?? []).filter((x) => x.isin === isin).reduce((s, x) => s + (x.realizedNet ?? 0), 0);
    realisedSnap.push(item(isin, c.realizedNet, snap));
  }
  R.compare('Realised', 'Realised net per ISIN: rebuilt vs snapshot holdings.realized / closed.realizedNet', realisedSnap);

  const div = { gross: 0, net: 0, tax: 0, fee: 0 };
  for (const p of positions.values()) for (const k of Object.keys(div)) div[k] += p.dividends[k];
  const pd = raw.performance?.performance?.dividends?.inInterval;
  const T = S?.totals ?? {};
  const nDiv = activities.filter((a) => a.type === 'dividend').length;
  R.compare('Dividends', 'Dividends gross/net/tax/fees: rebuilt vs Parqet', pd ? [
    item('gross', div.gross, pd.gainGross, sumTol(nDiv)), item('net', div.net, pd.gainNet, sumTol(nDiv)),
    item('tax', div.tax, pd.taxes, sumTol(nDiv)), item('fees', div.fee, pd.fees, sumTol(nDiv)),
  ] : []);
  R.compare('Dividends', 'Dividends gross/net/tax: rebuilt vs snapshot totals', [
    item('gross', div.gross, T.dividendsGross), item('net', div.net, T.dividendsNet), item('tax', div.tax, T.dividendsTax),
  ]);
  R.compare('Dividends', 'Dividends net per ISIN: rebuilt vs snapshot', [...combined].filter(([, c]) => c.dividends.count).map(([isin, c]) =>
    item(isin, c.dividends.net, snapSum(isin, (h) => h.dividendsNet) + sum((S?.closed ?? []).filter((x) => x.isin === isin), (x) => x.dividendsNet))));
  const fees = sum(activities, (a) => a.fee), taxes = sum(activities, (a) => a.tax);
  const pc = raw.performance?.performance;
  R.compare('Dividends', 'Fees & taxes (all activities): raw Σ vs Parqet vs snapshot', [
    ...(pc ? [item('fees vs Parqet', fees, pc.fees?.inInterval?.fees), item('taxes vs Parqet', taxes, pc.taxes?.inInterval?.taxes)] : []),
    item('fees vs snapshot', fees, T.fees), item('taxes vs snapshot', taxes, T.taxes),
  ]);
  R.compare('Dividends', 'totalGain = unrealized + realized + dividendsNet (snapshot)', [
    item('totalGain', T.unrealized + T.realized + T.dividendsNet, T.totalGain, 0.02)]);

  // ---- Returns -------------------------------------------------------------
  const end = raw.performance?.interval?.end ?? raw.charts?.interval?.end ?? dayOf(S?.meta?.asOf);
  const termV = pv ?? T.value;
  const flows = investorFlows(activities, { date: end, value: termV });
  const x = xirr(flows);
  const px = raw.performance?.performance?.kpis?.inInterval?.xirr;
  if (x) {
    const ours = x.rate * 100;
    R.compare('Returns', `XIRR (${x.method}, UTC days, ACT/365, net flows): rebuilt vs Parqet`, px != null ? [item('xirr %', ours, px, TOL.pct)] : []);
    R.compare('Returns', 'XIRR: rebuilt vs snapshot totals.xirr', [item('xirr %', ours, T.xirr, TOL.pct)]);
  } else R.add('FAIL', 'Returns', 'XIRR', 'no solution');
  for (const [pid, perf] of raw.perfByPortfolio) {
    const acts = activities.filter((a) => a.portfolioId === pid);
    const v = perf?.performance?.valuation?.atIntervalEnd;
    const r = v != null ? xirr(investorFlows(acts, { date: perf.interval?.end ?? end, value: v })) : null;
    const t = perf?.performance?.kpis?.inInterval?.xirr;
    if (r && t != null) R.compare('Returns', `XIRR ${nameOf(pid)}: rebuilt vs Parqet`, [item('xirr %', r.rate * 100, t, TOL.pct)]);
  }
  // Range XIRRs: Parqet treats the opening value as an investment made on the
  // day BEFORE the range start (matches to < 0.005 pp; dating it on the start
  // day is off by up to 0.3 pp). Parqet reports 0 for very short ranges (1M) —
  // those are skipped.
  const rangeItems = [];
  const skippedX = [];
  for (const [k, r] of Object.entries(raw.ranges ?? {})) {
    if (!r || typeof r !== 'object' || !r.start || !(r.startValue > 0) || r.xirr == null) continue;
    if (r.xirr === 0) { skippedX.push(k); continue; }
    const acts = activities.filter((a) => a.date >= r.start);
    const opening = new Date(Date.parse(r.start) - DAY_MS).toISOString().slice(0, 10);
    const fl = [{ date: opening, amount: -r.startValue }, ...investorFlows(acts, { date: end, value: r.endValue })];
    const rr = xirr(fl);
    if (rr) rangeItems.push(item(k, rr.rate * 100, r.xirr, TOL.pct));
  }
  if (rangeItems.length) R.compare('Returns', 'Range XIRR (opening value on start−1) vs Parqet ranges', rangeItems,
    { note: skippedX.length ? `Parqet reports 0 for ${skippedX.join(', ')} — skipped` : '' });

  // TTWROR: only rebuildable over the daily-resolution tail of the chart series.
  const pts = (raw.charts?.charts ?? []).filter((c) => c.mark !== 'bod')
    .map((c) => ({ date: dayOf(c.date), value: c.values?.history })).filter((p) => Number.isFinite(p.value));
  let dailyFrom = pts.length ? pts[0].date : null;
  for (let i = pts.length - 1; i > 0; i--) if (daysBetween(pts[i - 1].date, pts[i].date) > 4) { dailyFrom = pts[i].date; break; }
  const fbd = flowsByDay(activities);
  const tItems = [];
  const tSkipped = [];
  for (const [k, r] of Object.entries(raw.ranges ?? {})) {
    if (!r || typeof r !== 'object' || !r.start || r.ttwror == null) continue;
    const i0 = pts.findIndex((p) => p.date >= r.start) - 1;
    const base = pts[i0];
    if (i0 < 0 || base.date < dailyFrom || daysBetween(base.date, r.start) !== 1) { tSkipped.push(k); continue; }
    const t = ttwror(pts.slice(i0), fbd);
    if (t.pct != null) tItems.push(item(k, t.pct, r.ttwror, TOL.ttwrorSanity));
  }
  R.compare('Returns', 'TTWROR rebuilt from daily series vs Parqet ranges', tItems, {
    warnOnly: true,
    note: `sanity; series daily since ${dailyFrom}; not feasible for ${tSkipped.join(', ') || '—'} (sampled series / no base point)`,
  });
  const ptt = raw.performance?.performance?.kpis?.inInterval?.ttwror;
  if (ptt != null) R.compare('Returns', 'TTWROR (max) snapshot = Parqet (copied, not recomputable)', [item('ttwror %', T.ttwror, ptt, TOL.pct)]);
  const rngItems = [];
  for (const [k, r] of Object.entries(raw.ranges ?? {})) {
    const s = S?.ranges?.[k];
    if (!s || !r || typeof r !== 'object') continue;
    rngItems.push(item(`${k} ttwror`, s.ttwror, r.ttwror, TOL.pct), item(`${k} xirr`, s.xirr, r.xirr, TOL.pct));
    if (s.gain != null && r.gainNet != null) rngItems.push(item(`${k} gain`, s.gain, r.gainNet + (r.dividendsNet ?? 0)));
  }
  R.compare('Returns', 'Snapshot ranges = Parqet ranges (gain = gainNet + dividendsNet)', rngItems);

  // ---- Series --------------------------------------------------------------
  const ser = S?.series ?? [];
  if (ser.length) {
    const last = ser[ser.length - 1];
    R.compare('Series', 'Last point = totals.value / totals.invested', [item('value', last[1], T.value), item('invested', last[2], T.invested)]);
    const neg = ser.filter((p) => p[1] < 0 || p[2] < 0);
    R.add(neg.length ? 'FAIL' : 'PASS', 'Series', 'No negative values', `${neg.length} negative point(s)`, neg.map((p) => p[0]));
    const nonInc = [];
    for (let i = 1; i < ser.length; i++) if (!(ser[i][0] > ser[i - 1][0])) nonInc.push(`#${i} ${ser[i][0]} after ${ser[i - 1][0]}`);
    R.add(nonInc.length ? 'FAIL' : 'PASS', 'Series', 'Dates strictly increasing', `${nonInc.length} violation(s) in ${ser.length} points`, nonInc);
    const cp = (raw.charts?.charts ?? []).filter((c) => c.mark !== 'bod');
    if (cp.length) {
      const byDate = new Map(ser.map((p) => [p[0], p]));
      R.compare('Series', 'Snapshot series = Parqet chart (eod points)', cp.flatMap((c) => {
        const p = byDate.get(dayOf(c.date));
        return [item(`${dayOf(c.date)} value`, p?.[1], c.values.history), item(`${dayOf(c.date)} invested`, p?.[2], c.values.capitalHistory)];
      }), { note: `${ser.length} snapshot vs ${cp.length} Parqet eod points` });
      R.compare('Series', 'Parqet last capital = rebuilt Σ open FIFO cost', [item('capital', cp[cp.length - 1].values.capitalHistory, ourInvested, sumTol(H.length))]);
    }
  } else R.add('SKIP', 'Series', 'Series', 'snapshot has no series');

  // ---- Ledger --------------------------------------------------------------
  const L = S?.ledger ?? [];
  R.compare('Ledger', 'Row count = raw activities', [item('rows', L.length, activities.length, 0)]);
  const sign = { buy: -1, transfer_in: -1, fees_taxes: -1, sell: 1, dividend: 1, interest: 1, transfer_out: 1, deposit: 1, withdrawal: -1 };
  const types = [...new Set(activities.map((a) => a.type))];
  const ledgerItems = [];
  for (const t of types) {
    const raws = activities.filter((a) => a.type === t);
    const rows = L.filter((l) => String(l.type).toLowerCase() === t);
    ledgerItems.push(item(`${t} count`, rows.length, raws.length, 0));
    ledgerItems.push(item(`${t} gross`, sum(rows, (l) => l.gross), sum(raws, (a) => a.amount), sumTol(raws.length)));
    ledgerItems.push(item(`${t} fee`, sum(rows, (l) => l.fee), sum(raws, (a) => a.fee), sumTol(raws.length)));
    ledgerItems.push(item(`${t} tax`, sum(rows, (l) => l.tax), sum(raws, (a) => a.tax), sumTol(raws.length)));
    ledgerItems.push(item(`${t} net (signed)`, sum(rows, (l) => l.net), (sign[t] ?? 1) * sum(raws, (a) => a.amountNet), sumTol(raws.length)));
  }
  R.compare('Ledger', 'Count & sums by type = raw activities', ledgerItems);
  const badSign = L.filter((l) => { const s = sign[String(l.type).toLowerCase()]; return s && l.net !== 0 && Math.sign(l.net) !== s; });
  R.add(badSign.length ? 'FAIL' : 'PASS', 'Ledger', 'Signs (buys −, sells/dividends +)', `${badSign.length} row(s) with unexpected sign`, badSign.map((l) => `${l.d} ${l.type} ${l.isin}`));
  // per-row: same (type, ISIN, UTC day, gross) and, for trades, same shares
  // (the snapshot leaves shares/price empty on income rows)
  const rk = (t, isin, d, sh, g) => `${t}|${isin}|${d}|${INFLOW.has(t) || OUTFLOW.has(t) ? Math.round(sh * 1e6) : '-'}|${Math.round(g * 100)}`;
  const pool = new Map();
  for (const a of activities) { const k = rk(a.type, a.isin, a.date, a.shares, a.amount); pool.set(k, (pool.get(k) ?? 0) + 1); }
  const unmatched = [];
  for (const l of L) {
    const k = rk(String(l.type).toLowerCase(), l.isin, l.d, l.shares ?? 0, l.gross ?? 0);
    if (pool.get(k)) pool.set(k, pool.get(k) - 1); else unmatched.push(`${l.d} ${l.type} ${l.isin}`);
  }
  R.add(unmatched.length ? 'FAIL' : 'PASS', 'Ledger', 'Every row matches a raw activity (type, ISIN, UTC day, gross, trade shares)',
    `${L.length - unmatched.length}/${L.length} matched`, unmatched);

  // ---- Freshness -----------------------------------------------------------
  const nowMs = now.getTime();
  const ageDays = (iso) => (nowMs - Date.parse(iso)) / DAY_MS;
  const openQuotes = phList.filter((h) => !h.position.isSold && h.quote?.datetime).map((h) => ({ isin: h.asset?.isin, at: h.quote.datetime }));
  if (openQuotes.length) {
    const newest = openQuotes.reduce((a, b) => (a.at > b.at ? a : b));
    const oldest = openQuotes.reduce((a, b) => (a.at < b.at ? a : b));
    R.add(ageDays(newest.at) > TOL.staleDays ? 'WARN' : 'PASS', 'Freshness', 'Newest quote age', `${ageDays(newest.at).toFixed(1)} days (${newest.at})`);
    const stale = openQuotes.filter((q) => ageDays(q.at) > TOL.staleDays);
    R.add(stale.length ? 'WARN' : 'PASS', 'Freshness', 'Oldest open-position quote age', `${ageDays(oldest.at).toFixed(1)} days`, stale.map((q) => `${q.isin} ${q.at}`));
  } else R.add('SKIP', 'Freshness', 'Quote age', 'no open Parqet holdings with quotes');
  for (const [label, at] of [['Snapshot converted', S?.meta?.convertedAt], ['Snapshot asOf', S?.meta?.asOf]]) {
    if (!at) { R.add('SKIP', 'Freshness', label, 'missing'); continue; }
    R.add(ageDays(at) > TOL.staleDays ? 'WARN' : 'PASS', 'Freshness', `${label} age`, `${ageDays(at).toFixed(1)} days (${at})`);
  }
  return { report: R, positions, combined, activities, flows, xirr: x };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function formatReport(R, { verbose = false } = {}) {
  const w = { s: 6, g: 11, n: Math.min(72, Math.max(...R.rows.map((r) => r.name.length))) };
  const lines = [`${'STATUS'.padEnd(w.s)}  ${'GROUP'.padEnd(w.g)}  ${'CHECK'.padEnd(w.n)}  DETAIL`, '-'.repeat(w.s + w.g + w.n + 40)];
  for (const r of R.rows) {
    lines.push(`${r.status.padEnd(w.s)}  ${r.group.padEnd(w.g)}  ${r.name.padEnd(w.n)}  ${r.detail}`);
    if ((verbose || r.status === 'FAIL' || r.status === 'WARN') && r.items.length) {
      for (const i of r.items.slice(0, verbose ? Infinity : 8)) lines.push(`${' '.repeat(w.s + w.g + 4)}· ${i}`);
      if (!verbose && r.items.length > 8) lines.push(`${' '.repeat(w.s + w.g + 4)}· … ${r.items.length - 8} more (--verbose)`);
    }
  }
  const c = (s) => R.rows.filter((r) => r.status === s).length;
  lines.push('', `${c('PASS')} pass, ${c('FAIL')} fail, ${c('WARN')} warn, ${c('SKIP')} skip`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const root = resolve(here, '..', '..');
  const o = {
    raw: join(root, 'imports', 'parqet', 'raw'),
    snapshot: join(root, 'prototype', 'data', 'portfolio.local.js'),
    splits: join(root, 'tools', 'parqet-import', 'corporate-actions.json'),
    now: null, verbose: false, json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verbose' || a === '-v') o.verbose = true;
    else if (a === '--json') o.json = true;
    else if (['--raw', '--snapshot', '--splits', '--now'].includes(a)) o[a.slice(2)] = argv[++i];
    else if (a === '--help' || a === '-h') { o.help = true; }
  }
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('usage: node tools/audit/audit.mjs [--raw DIR] [--snapshot FILE] [--splits FILE] [--now ISO] [--verbose] [--json]');
    process.exit(0);
  }
  const raw = loadRaw(o.raw);
  const snapshot = existsSync(o.snapshot) ? loadSnapshot(o.snapshot) : null;
  if (!raw.actPayloads.length || !snapshot) {
    console.error(`audit: need raw activities in ${o.raw} and a snapshot at ${o.snapshot}`);
    process.exit(2);
  }
  const splits = existsSync(o.splits) ? readJSON(o.splits).splits : [];
  const { report } = runAudit({ raw, snapshot, splits, now: o.now ? new Date(o.now) : new Date() });
  console.log(o.json ? JSON.stringify(report.rows, null, 2) : formatReport(report, o));
  process.exit(report.failed ? 1 : 0);
}
