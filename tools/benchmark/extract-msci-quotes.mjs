// Collects every iShares Core MSCI World (IE00B4L5Y983) quote that Parqet returned during a
// Claude Code session, from parqet_get_performance results (holding startQuote / quote).
// Parqet has no price-history tool, so month-end prices come from one call per month over a
// portfolio that held the ETF then (DADAT from Dec 2017, flatex from Jan 2023): an absolute
// interval [1st, last day] returns the previous month's close as startQuote and this month's
// close as quote, so calling every other month covers every month-end.
// Usage: node tools/benchmark/extract-msci-quotes.mjs <session.jsonl> imports/benchmark/msci-world.json
// Quotes with exchange "activity" are trade prices, not closes; a close wins over them.
import fs from 'node:fs';
const [jsonl, out] = process.argv.slice(2);
const ISIN = 'IE00B4L5Y983';
const quotes = new Map(); // date -> {price, exchange}
const texts = [];
for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
  if (!line.includes(ISIN)) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  const walk = v => { if (typeof v === 'string') { if (v.includes(ISIN) && v.trim().startsWith('{')) texts.push(v); } else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(o);
}
const dir = jsonl.replace(/\.jsonl$/, '') + '/tool-results';
if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) { const t = fs.readFileSync(`${dir}/${f}`, 'utf8'); if (t.includes(ISIN)) texts.push(t); }
const add = (q) => {
  if (!q || !q.price || q.exchange === 'fallbackexchange') return;
  const d = q.datetime.slice(0, 10);
  const prev = quotes.get(d);
  if (prev && prev.exchange !== 'activity' && q.exchange === 'activity') return;
  if (prev && prev.price !== q.price && prev.exchange !== 'activity') console.error('conflict', d, prev.price, q.price);
  quotes.set(d, { price: q.price, exchange: q.exchange });
};
let n = 0;
for (const t of texts) {
  let j; try { j = JSON.parse(t); } catch { continue; }
  const hs = [j.holdings, j.performance?.holdings].find(Array.isArray) ?? [];
  for (const h of hs) if (h.asset?.isin === ISIN) { add(h.startQuote); add(h.quote); n++; }
}
const rows = [...quotes].sort(([a], [b]) => a.localeCompare(b)).map(([date, q]) => ({ date, ...q }));
fs.writeFileSync(out, JSON.stringify({ isin: ISIN, name: 'iShares Core MSCI World UCITS ETF (Acc)', currency: 'EUR', source: 'Parqet historical quotes', quotes: rows }, null, 1));
console.log('holding hits', n, 'quotes', rows.length);
console.log(rows.map(r => `${r.date} ${r.price}${r.exchange==='activity'?'*':''}`).join('\n'));
