#!/usr/bin/env node
/**
 * Parqet → portfolio snapshot converter.
 *
 * Reads raw payloads captured from the Parqet MCP connector (or the Parqet
 * Connect API, which returns the same shapes) and writes the snapshot the
 * prototype renders: window.PORTFOLIO = {...}.
 *
 * The ledger is the truth: positions and lots are rebuilt from the raw
 * activities, then reconciled against Parqet's own reported shares and cost
 * basis. A mismatch is reported, never silently papered over.
 *
 *   node tools/parqet-import/convert.mjs [rawDir] [outFile]
 *
 * Defaults: imports/parqet/raw → prototype/data/portfolio.local.js
 * Both locations are gitignored. Never point outFile at a tracked path.
 *
 * Money is handled in float and rounded at the edges here; the production
 * importer (packages/importers/parqet-api) uses decimal.js per the plan.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const rawDir = resolve(process.argv[2] ?? "imports/parqet/raw");
const outFile = resolve(process.argv[3] ?? "prototype/data/portfolio.local.js");

const read = (f, optional = false) => {
  const p = join(rawDir, f);
  if (!existsSync(p)) {
    if (optional) return null;
    throw new Error(`Missing ${p} — capture it from Parqet first (see README.md).`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
};

const activitiesRaw = read("activities.json");
const performance = read("performance.json");
const charts = read("overview-charts.json");
const day = read("day.json", true);
const rangesRaw = read("ranges.json", true);
const portfolioRaw = read("portfolio.json", true);
const corporate = JSON.parse(readFileSync(new URL("./corporate-actions.json", import.meta.url), "utf8"));
const splitsBy = new Map();
for (const sp of corporate.splits) {
  if (!splitsBy.has(sp.isin)) splitsBy.set(sp.isin, []);
  splitsBy.get(sp.isin).push(sp);
}
for (const list of splitsBy.values()) list.sort((a, b) => a.exDate.localeCompare(b.exDate));

const r2 = n => Math.round(n * 100) / 100;
const r6 = n => Math.round(n * 1e6) / 1e6;
const EPS_SHARES = 1e-6, EPS_EUR = 0.01;

if (activitiesRaw.cursor) throw new Error("activities.json is a partial page (cursor set) — fetch all pages first.");
if (activitiesRaw.activities.length !== activitiesRaw.totalActivities)
  throw new Error(`activities.json holds ${activitiesRaw.activities.length} of ${activitiesRaw.totalActivities} rows.`);

/* ---------------------------------------------------------------- names */
function shortName(name, kind) {
  let s = name.replace(/[‘’']/g, "").replace(/\s+/g, " ").trim();
  if (kind === "ETF") {
    s = s.replace(/^(iShares|iShs|Xtrackers|Vanguard|Amundi|Lyxor|SPDR|Invesco)\s+/i, "")
         .replace(/\s*\(DE\)/, "")
         .replace(/\s+UCITS.*$/i, "")
         .replace(/\s+ETF.*$/i, "")
         .replace(/^Tr\.-/, "");
  }
  return s.replace(/\s+(NK-,?\d+\s+)?Aktie$/i, "").replace(/\s+ASA.*$/, " ASA").trim();
}
const kindOf = name => (/\bETF\b/i.test(name) ? "ETF" : "Stock");

/* ------------------------------------------------------------- holdings */
const holdings = new Map();
for (const h of performance.holdings) {
  const kind = kindOf(h.asset.name);
  holdings.set(h.id, {
    id: h.id, isin: h.asset.isin, name: h.asset.name, short: shortName(h.asset.name, kind), kind,
    position: h.position, quote: h.quote,
    realizedNet: h.performance.realizedGains.inInterval.gainNet,
    unrealizedNet: h.performance.unrealizedGains.inInterval.gainNet,
    dividendsNet: h.performance.dividends.inInterval.gainNet,
    fees: h.performance.fees.inInterval.fees,
    activities: [],
  });
}

/* ----------------------------------------------------------- activities */
// Stable chronological order; Parqet encodes same-instant ordering in the
// millisecond field (e.g. ...07:00:00.000 buy, ...07:00:00.001 sell).
const acts = activitiesRaw.activities
  .map((a, i) => ({ ...a, _i: i }))
  .sort((a, b) => a.datetime.localeCompare(b.datetime) || a._i - b._i);

for (const a of acts) {
  const h = holdings.get(a.holdingId);
  if (!h) throw new Error(`Activity ${a.id} references unknown holding ${a.holdingId}`);
  if (a.currency !== "EUR") throw new Error(`Activity ${a.id} is in ${a.currency}; FX handling not implemented for this source yet.`);
  h.activities.push(a);
}

/**
 * Rebuild open lots from raw activities, applying splits on their ex-date.
 * Tracks four cost-basis variants at once so reconciliation can say which
 * one the source used: {FIFO, moving average} × {fees in, fees out}.
 * Austrian KESt uses moving average with fees excluded (Privatvermögen).
 */
function rebuild(h) {
  const splits = (splitsBy.get(h.isin) ?? []).slice();
  const fifo = [];                          // {date, shares, price, gross, fee}
  const avg = { shares: 0, incl: 0, excl: 0 };
  const applied = [];
  const applySplitsUpTo = date => {
    while (splits.length && splits[0].exDate <= date) {
      const sp = splits.shift();
      if (!fifo.length && avg.shares === 0) continue;   // nothing held: irrelevant
      for (const l of fifo) { l.shares *= sp.ratio; l.price /= sp.ratio; }
      avg.shares *= sp.ratio;
      applied.push(sp);
    }
  };
  for (const a of h.activities) {
    const date = a.datetime.slice(0, 10);
    applySplitsUpTo(date);
    if (a.type === "buy" || a.type === "transfer_in") {
      fifo.push({ date, shares: a.shares, price: a.price, gross: a.amount, fee: a.fee, adj: 1 });
      avg.shares += a.shares; avg.incl += a.amount + a.fee; avg.excl += a.amount;
    } else if (a.type === "sell" || a.type === "transfer_out") {
      let left = a.shares;
      while (left > EPS_SHARES && fifo.length) {
        const lot = fifo[0], take = Math.min(left, lot.shares), f = take / lot.shares;
        lot.gross -= lot.gross * f; lot.fee -= lot.fee * f;
        lot.shares -= take; left -= take;
        if (lot.shares <= EPS_SHARES) fifo.shift();
      }
      if (left > EPS_SHARES) return { error: `sells ${r6(left)} more shares than held on ${date} — a split missing from corporate-actions.json?` };
      const f = a.shares / avg.shares;
      avg.incl -= avg.incl * f; avg.excl -= avg.excl * f; avg.shares -= a.shares;
      if (avg.shares <= EPS_SHARES) Object.assign(avg, { shares: 0, incl: 0, excl: 0 });
    }
  }
  applySplitsUpTo("9999-12-31");
  const sum = k => fifo.reduce((s, l) => s + l[k], 0);
  return {
    fifo, applied, shares: sum("shares"),
    cost: { fifoIncl: sum("gross") + sum("fee"), fifoExcl: sum("gross"), avgIncl: avg.incl, avgExcl: avg.excl },
  };
}
const METHOD_LABEL = { fifoExcl: "FIFO, fees excluded", fifoIncl: "FIFO, fees included",
                       avgExcl: "moving average, fees excluded", avgIncl: "moving average, fees included" };

const open = [], closed = [], reconcile = [];
for (const h of holdings.values()) {
  const rb = rebuild(h);
  const theirs = h.position;
  const first = h.activities[0]?.datetime.slice(0, 10);
  const last = h.activities[h.activities.length - 1]?.datetime.slice(0, 10);
  const check = { isin: h.isin, name: h.short };
  if (rb.error) {
    Object.assign(check, { ok: false, issue: rb.error });
  } else {
    const sharesOk = Math.abs(rb.shares - theirs.shares) < EPS_SHARES;
    const matches = Object.keys(rb.cost).filter(k => Math.abs(rb.cost[k] - theirs.purchaseValue) < EPS_EUR);
    Object.assign(check, {
      ok: sharesOk && (theirs.isSold || matches.length > 0),
      shares: { ours: r6(rb.shares), parqet: r6(theirs.shares) },
      cost: Object.fromEntries([...Object.entries(rb.cost).map(([k, v]) => [k, r2(v)]), ["parqet", r2(theirs.purchaseValue)]]),
      matches: matches.map(k => METHOD_LABEL[k]),
      splits: rb.applied.map(sp => ({ exDate: sp.exDate, ratio: sp.ratio })),
    });
  }
  if (!theirs.isSold || !check.ok) reconcile.push(check);   // closed positions surface only when broken

  if (theirs.isSold) {
    closed.push({ isin: h.isin, name: h.short, fullName: h.name, kind: h.kind,
      realizedNet: r2(h.realizedNet), dividendsNet: r2(h.dividendsNet), first, last, trades: h.activities.length });
    continue;
  }
  const d = day?.holdings?.[h.isin];
  open.push({
    id: h.id, isin: h.isin, name: h.short, fullName: h.name, kind: h.kind,
    shares: r6(theirs.shares), price: theirs.currentPrice, value: r2(theirs.currentValue),
    cost: r2(theirs.purchaseValue), avg: r2(theirs.purchasePrice),
    unrealized: r2(theirs.currentValue - theirs.purchaseValue),
    unrealizedPct: theirs.purchaseValue ? r2((theirs.currentValue / theirs.purchaseValue - 1) * 100) : 0,
    realized: r2(h.realizedNet), dividendsNet: r2(h.dividendsNet),
    dayAbs: d ? r2(d.atIntervalEnd - d.atIntervalStart) : null,
    dayPct: d ? r2((d.atIntervalEnd / d.atIntervalStart - 1) * 100) : null,
    quote: { exchange: h.quote.exchange, at: h.quote.datetime },
    first, trades: h.activities.length,
    splits: check.splits ?? [],
    costAustria: rb.cost ? r2(rb.cost.avgExcl) : null,
    lots: (rb.fifo ?? []).map(l => ({ date: l.date, shares: r6(l.shares), price: r6(l.price), cost: r2(l.gross), fee: r2(l.fee) })),
  });
}
open.sort((a, b) => b.value - a.value);
closed.sort((a, b) => b.realizedNet - a.realizedNet);

/* --------------------------------------------------------------- ledger */
const signed = a => (a.type === "buy" || a.type === "transfer_in" ? -1 : 1) * a.amountNet;
const ledger = acts.slice().reverse().map(a => {
  const h = holdings.get(a.holdingId);
  const later = (splitsBy.get(h.isin) ?? []).filter(sp => sp.exDate > a.datetime.slice(0, 10));
  const preSplit = later.reduce((m, sp) => m * sp.ratio, 1);
  return {
    preSplit: preSplit > 1 && a.type !== "dividend" ? preSplit : undefined,
    d: a.datetime.slice(0, 10), type: a.type.toUpperCase(), name: h.short, isin: h.isin,
    shares: a.type === "dividend" ? null : r6(a.shares), price: a.type === "dividend" ? null : r2(a.price),
    gross: r2(a.amount), fee: r2(a.fee), tax: r2(a.tax), net: r2(signed(a)),
  };
});

/* --------------------------------------------------------------- series */
// history = market value; capitalHistory = cost basis of positions held that day.
const series = charts.charts
  .filter(p => p.values && typeof p.values.history === "number")
  .map(p => [p.date.slice(0, 10), r2(p.values.history), r2(p.values.capitalHistory)]);

/* --------------------------------------------------------------- totals */
const P = performance.performance;
const value = P.valuation.atIntervalEnd;
const totals = {
  value: r2(value),
  invested: r2(open.reduce((s, h) => s + h.cost, 0)),
  unrealized: r2(P.unrealizedGains.inInterval.gainNet),
  realized: r2(P.realizedGains.inInterval.gainNet),
  dividendsGross: r2(P.dividends.inInterval.gainGross),
  dividendsNet: r2(P.dividends.inInterval.gainNet),
  dividendsTax: r2(P.dividends.inInterval.taxes),
  fees: r2(P.fees.inInterval.fees),
  taxes: r2(P.taxes.inInterval.taxes),
  xirr: r2(P.kpis.inInterval.xirr),
  ttwror: r2(P.kpis.inInterval.ttwror),
  dayAbs: day ? r2(day.portfolio.atIntervalEnd - day.portfolio.atIntervalStart) : null,
  dayPct: day ? r2((day.portfolio.atIntervalEnd / day.portfolio.atIntervalStart - 1) * 100) : null,
};
// Parqet's own gains.totalNet excludes dividends; ours includes them, labelled as such.
totals.totalGain = r2(totals.realized + totals.unrealized + totals.dividendsNet);
totals.costBasisMethod = "FIFO, fees excluded";

// Per-range returns come from the source, not from the series: realised gains
// leave the series as cash, so value deltas alone would understate returns.
const ranges = rangesRaw ? Object.fromEntries(Object.entries(rangesRaw).filter(([k]) => !k.startsWith("_"))
  .map(([k, v]) => [k, { start: v.start, ttwror: r2(v.ttwror), xirr: r2(v.xirr), gain: r2(v.gainNet + v.dividendsNet) }])) : null;

const counts = acts.reduce((m, a) => (m[a.type] = (m[a.type] ?? 0) + 1, m), {});
const snapshot = {
  meta: {
    source: "parqet", isDemo: false, currency: performance.currency,
    portfolio: { id: activitiesRaw.portfolioId, name: portfolioRaw?.name ?? "Parqet portfolio" },
    since: performance.interval.start, asOf: open.reduce((m, h) => (h.quote.at > m ? h.quote.at : m), ""),
    convertedAt: new Date().toISOString(),
  },
  totals, ranges, holdings: open, closed, ledger, series,
  sync: {
    source: "Parqet", activities: acts.length, counts,
    holdingsTotal: holdings.size, holdingsOpen: open.length, holdingsClosed: closed.length,
    reconcile,
  },
};

/* --------------------------------------------------------------- output */
const failures = reconcile.filter(c => !c.ok);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile,
  "/* Generated by tools/parqet-import/convert.mjs — personal data, gitignored. Do not commit. */\n" +
  "window.PORTFOLIO = " + JSON.stringify(snapshot) + ";\n");

console.log(`Parqet snapshot → ${outFile}`);
console.log(`  ${acts.length} activities · ${open.length} open / ${closed.length} closed positions · ${series.length} series points`);
console.log(`  value €${totals.value} · invested €${totals.invested} · total gain €${totals.totalGain} · XIRR ${totals.xirr}%`);
for (const c of reconcile) {
  const sp = c.splits?.length ? ` · splits ${c.splits.map(x => x.ratio + ":1 " + x.exDate).join(", ")}` : "";
  console.log(c.ok ? "  ✓" : "  ✗", c.name.padEnd(16), c.issue ??
    `shares ${c.shares.ours} = ${c.shares.parqet}${sp}\n${" ".repeat(20)}cost ${JSON.stringify(c.cost)}\n${" ".repeat(20)}matches: ${c.matches.join(" | ") || "none"}`);
}
if (failures.length) { console.error(`\n${failures.length} position(s) do not reconcile with Parqet.`); process.exitCode = 2; }
