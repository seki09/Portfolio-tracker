// Builds the three data files behind the "Portfolio vs MSCI World" dashboard.
// Run from the repository root: node tools/benchmark/build-dashboard-data.mjs
// Reads (all gitignored): imports/parqet/raw/{overview-charts,ranges}.json and
// imports/benchmark/msci-world.json (see extract-msci-quotes.mjs).
// Writes (gitignored): imports/benchmark/dashboard/{portfolio-history,msci-world-monthly,period-returns}.json
import fs from 'node:fs';
const RAW = 'imports/parqet/raw';
const OUT = 'imports/benchmark/dashboard';
fs.mkdirSync(OUT, { recursive: true });
const charts = JSON.parse(fs.readFileSync(`${RAW}/overview-charts.json`, 'utf8')).charts;
const msci = JSON.parse(fs.readFileSync('imports/benchmark/msci-world.json', 'utf8')).quotes;
const ranges = JSON.parse(fs.readFileSync(`${RAW}/ranges.json`, 'utf8'));
const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 1e4) / 1e4;
// 1. portfolio history: one row per chart date (drop duplicate dates, keep last)
const byDate = new Map();
for (const p of charts) byDate.set(p.date.slice(0, 10), p);
const hist = [...byDate].map(([date, p]) => ({ date, value_eur: r2(p.values.history), invested_eur: r2(p.values.capitalHistory), twr_pct: r4(p.values.ttwror), drawdown_pct: r4(p.values.drawdown) }));
// 2. MSCI month-end closes (drop the extra mid-month point; keep last per month)
const mm = new Map();
for (const q of msci) mm.set(q.date.slice(0, 7), q);
const bench = [...mm.values()].map((q) => ({ date: q.date, close_eur: r4(q.price), price_type: q.exchange === 'activity' ? 'trade price' : 'close', exchange: q.exchange }));
// 3. period returns: Parqet's portfolio TWR per window + MSCI ETF price at both ends.
// The ETF prices are public market data (IE00B4L5Y983, EUR) taken from the startQuote/quote of
// parqet_get_performance calls over the same absolute windows as of the Oct 10, 2026 sync.
// Refreshing means re-running those calls and replacing these constants.
const m = { '1M': ['2026-09-09', 126.125], '6M': ['2026-04-09', 113.05], 'YTD': ['2025-12-30', 111.725], '1Y': ['2025-10-09', 110.16], '5Y': ['2021-10-08', 72.69] };
const periods = Object.entries(m).map(([k, [d, px]]) => ({ period: k, start: ranges[k].interval.start, end: ranges[k].interval.end, portfolio_twr_pct: r4(ranges[k].returns.ttwror), portfolio_xirr_pct: r4(ranges[k].returns.xirr), msci_start_date: d, msci_start_eur: px, msci_end_date: '2026-10-09', msci_end_eur: 131.905 }));
periods.push({ period: 'MAX', start: ranges.MAX.interval.start, end: ranges.MAX.interval.end, portfolio_twr_pct: r4(ranges.MAX.returns.ttwror), portfolio_xirr_pct: r4(ranges.MAX.returns.xirr), msci_start_date: null, msci_start_eur: null, msci_end_date: null, msci_end_eur: null });
fs.writeFileSync(`${OUT}/portfolio-history.json`, JSON.stringify(hist));
fs.writeFileSync(`${OUT}/msci-world-monthly.json`, JSON.stringify(bench));
fs.writeFileSync(`${OUT}/period-returns.json`, JSON.stringify(periods));
console.log(hist.length, 'hist rows', fs.statSync(`${OUT}/portfolio-history.json`).size, 'bytes; first', hist[0], 'last', hist.at(-1));
console.log(bench.length, 'bench rows; first', bench[0], 'last', bench.at(-1), bench.filter(b => b.price_type !== 'close'));
console.table(periods.map(p => ({ ...p, msci_pct: p.msci_start_eur ? r2((p.msci_end_eur / p.msci_start_eur - 1) * 100) : null })));
// sanity: monthly alignment + headline numbers
const lastIn = (rows, key) => { const g = new Map(); for (const r of rows) g.set(r.date.slice(0, 7), r); return g; };
const pm = lastIn(hist), bm = lastIn(bench);
const months = [...bm.keys()].filter((k) => k >= '2017-12' && pm.has(k));
const p0 = 1 + pm.get('2017-12').twr_pct / 100, b0 = bm.get('2017-12').close_eur;
const rows = months.map((k) => ({ month: k, p: (1 + pm.get(k).twr_pct / 100) / p0 * 100, b: bm.get(k).close_eur / b0 * 100, pd: pm.get(k).date, bd: bm.get(k).date }));
console.log(months.length, 'aligned months', rows[0], rows.at(-1));
const gaps = rows.filter(r => Math.abs(new Date(r.pd) - new Date(r.bd)) > 4 * 864e5); console.log('date gaps >4d', gaps.length, gaps.slice(0, 8).map(r => `${r.month} ${r.pd} ${r.bd}`));
const yrs = (new Date(rows.at(-1).pd) - new Date(rows[0].pd)) / 864e5 / 365.25;
const L = rows.at(-1); console.log('years', yrs.toFixed(2), 'p cagr', ((L.p / 100) ** (1 / yrs) - 1) * 100, 'b cagr', ((L.b / 100) ** (1 / yrs) - 1) * 100);
let pk = 0, bk = 0, pdd = 0, bdd = 0; for (const r of rows) { pk = Math.max(pk, r.p); bk = Math.max(bk, r.b); pdd = Math.min(pdd, r.p / pk - 1); bdd = Math.min(bdd, r.b / bk - 1); } console.log('max dd monthly', pdd * 100, bdd * 100);
let best = null; for (let i = 1; i < rows.length; i++) { const x = rows[i].p / rows[i - 1].p - 1; if (!best || x > best.x) best = { m: rows[i].month, x }; } console.log('best month', best);
const beat = rows.slice(1).filter((r, i) => r.p / rows[i].p > r.b / rows[i].b).length; console.log('months beaten', beat, 'of', rows.length - 1);
