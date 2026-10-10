// node --test tools/parqet-import/*.test.mjs
// Synthetic two-broker portfolio (all values invented) → convert.mjs → combined account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

const CONVERT = new URL("./convert.mjs", import.meta.url).pathname;
const act = (id, pf, holdingId, isin, type, datetime, shares, price, fee = 0, tax = 0) => {
  const amount = shares * price;
  const amountNet = type === "buy" ? amount + fee : amount - fee - tax;
  return { id, type, datetime, holdingId, subAccount: `${pf}::null`, currency: "EUR", fx: null, shares, price, amount, amountNet, fee, tax,
    asset: { assetIdentifierType: "isin", isin }, holdingAssetType: "security", description: "" };
};
const perfBlock = (realized = 0, unrealized = 0, div = 0) => ({
  kpis: { inInterval: { xirr: 0, ttwror: 0 } }, fees: { inInterval: { fees: 0 } }, taxes: { inInterval: { taxes: 0 } },
  unrealizedGains: { inInterval: { gainNet: unrealized, gainGross: unrealized } }, realizedGains: { inInterval: { gainNet: realized, gainGross: realized } },
  dividends: { inInterval: { gainNet: div, gainGross: div, taxes: 0, fees: 0 } }, valuation: { atIntervalStart: 0, atIntervalEnd: 0 } });
const holding = (id, pf, isin, name, shares, purchaseValue, price, realized) => ({
  id, subAccount: `${pf}::null`, asset: { type: "security", isin, name }, currency: "EUR",
  quote: { currency: "EUR", exchange: "xetra", datetime: "2024-12-30T17:00:00.000Z", price }, performance: perfBlock(realized, shares * price - purchaseValue),
  position: { shares, purchaseValue, purchasePrice: shares ? purchaseValue / shares : 0, currentPrice: price, currentValue: shares * price, isSold: shares === 0 } });

function build() {
  const dir = mkdtempSync(join(tmpdir(), "parqet-multi-"));
  const w = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o));
  w("portfolios.json", { items: [{ id: "pfA", name: "Broker A", currency: "EUR" }, { id: "pfB", name: "Broker B", currency: "EUR" }] });
  const A = [
    act("a1", "pfA", "hA-X", "IE00TEST0001", "buy", "2024-01-10T09:00:00.000Z", 10, 100, 1),          // open 10 @ 100 → cost 1000
    act("a2", "pfA", "hA-Z", "DE00TEST0003", "buy", "2024-02-01T09:00:00.000Z", 3, 10, 1),
    act("a3", "pfA", "hA-Z", "DE00TEST0003", "sell", "2024-05-01T09:00:00.000Z", 3, 9, 1),             // Z closed at A
  ];
  const B = [
    act("b1", "pfB", "hB-X", "IE00TEST0001", "buy", "2024-03-01T09:00:00.000Z", 5, 120, 1),
    act("b2", "pfB", "hB-X", "IE00TEST0001", "sell", "2024-06-01T09:00:00.000Z", 5, 130, 1, 3),         // sold out at B...
    act("b3", "pfB", "hB-X", "IE00TEST0001", "buy", "2024-07-01T09:00:00.000Z", 4, 110, 1),            // ...and bought back: 4 @ 110 → 440
    act("b4", "pfB", "hB-Y", "US00TEST0002", "buy", "2024-04-01T09:00:00.000Z", 2, 50, 1),
    act("b5", "pfB", "hB-Y", "US00TEST0002", "sell", "2024-08-01T09:00:00.000Z", 2, 60, 1),            // Y closed at B
    act("b6", "pfB", "hB-Z", "DE00TEST0003", "buy", "2024-02-15T09:00:00.000Z", 1, 8, 0),
    act("b7", "pfB", "hB-Z", "DE00TEST0003", "sell", "2024-05-15T09:00:00.000Z", 1, 9, 0),             // Z closed at B too
  ];
  w("activities-pfA.json", { portfolioId: "pfA", activities: A, cursor: null, totalActivities: A.length });
  w("activities-pfB.json", { portfolioId: "pfB", activities: B, cursor: null, totalActivities: B.length });
  w("performance.json", {
    currency: "EUR", interval: { start: "2024-01-10", end: "2024-12-30" },
    // Realised (Parqet net = sell amountNet − FIFO cost − sold lots' buy fees):
    //   X at B: (650 − 1 − 3) − (600 + 1) = 45 · Y: (120 − 1) − (100 + 1) = 18
    //   Z at A: (27 − 1) − (30 + 1) = −5        · Z at B: 9 − 8 = 1           → total 59
    // Cash-flow truth: value 2100 + Σ received 800 − Σ paid 2183 = 717 = 59 + unrealised 658
    performance: { ...perfBlock(59, 658, 0), kpis: { inInterval: { xirr: 12.3, ttwror: 20.1 } }, valuation: { atIntervalStart: 0, atIntervalEnd: 2100 } },
    holdings: [
      holding("hA-X", "pfA", "IE00TEST0001", "Test World UCITS ETF", 10, 1000, 150, 0),
      holding("hB-X", "pfB", "IE00TEST0001", "Test World UCITS ETF", 4, 440, 150, 45),
      holding("hB-Y", "pfB", "US00TEST0002", "Test Corp", 0, 0, 60, 18),
      holding("hA-Z", "pfA", "DE00TEST0003", "Test AG", 0, 0, 9, -5),
      holding("hB-Z", "pfB", "DE00TEST0003", "Test AG", 0, 0, 9, 1),
    ] });
  w("overview-charts.json", { charts: [
    { date: "2024-01-10T00:00:00.000Z", values: { history: 1000, capitalHistory: 1000 } },
    { date: "2024-12-30T00:00:00.000Z", values: { history: 2100, capitalHistory: 1440 } } ] });
  const out = join(dir, "snapshot.local.js");
  execFileSync(process.execPath, [CONVERT, dir, out], { stdio: "pipe" });
  const ctx = { window: {} }; vm.runInNewContext(readFileSync(out, "utf8"), ctx);
  return JSON.parse(JSON.stringify(ctx.window.PORTFOLIO));   // same-realm objects for deepStrictEqual
}

test("two brokers merge into one combined account", () => {
  const P = build();
  assert.equal(P.meta.portfolio.name, "All accounts");
  assert.deepEqual(P.meta.portfolio.accounts.map(a => [a.name, a.activities]), [["Broker A", 3], ["Broker B", 7]]);
});

test("same security at two brokers is one position with per-account lots", () => {
  const [x] = P0().holdings;
  assert.equal(P0().holdings.length, 1);
  assert.equal(x.isin, "IE00TEST0001");
  assert.equal(x.shares, 14);                                  // 10 at A + 4 at B
  assert.equal(x.value, 2100);                                 // 14 × 150
  assert.equal(x.cost, 1440);                                  // 1000 + 440 (FIFO, fees excluded)
  assert.equal(x.avg, 102.86);                                 // 1440 / 14
  assert.equal(x.unrealized, 658);                             // 2100 − 1440 − open-lot buy fees (1 + 1)
  assert.equal(x.realized, 45);                                // B's sell-out stays with the open position
  assert.deepEqual(x.accounts.map(a => [a.name, a.shares]), [["Broker A", 10], ["Broker B", 4]]);
  assert.deepEqual(x.lots.map(l => [l.date, l.shares, l.account]), [["2024-01-10", 10, "Broker A"], ["2024-07-01", 4, "Broker B"]]);
});

test("closed at every broker → one closed entry with realised results summed", () => {
  const closed = Object.fromEntries(P0().closed.map(c => [c.isin, c.realizedNet]));
  assert.deepEqual(closed, { "US00TEST0002": 18, "DE00TEST0003": -4 });   // Z: −5 at A + 1 at B
});

test("every per-broker holding reconciles and the ledger names accounts", () => {
  const P = P0();
  assert.ok(P.sync.reconcile.every(c => c.ok), JSON.stringify(P.sync.reconcile));
  assert.equal(P.totals.totalGain, 717);                       // equals the cash-flow truth above
  assert.equal(P.ledger.length, 10);
  assert.deepEqual([...new Set(P.ledger.map(l => l.account))].sort(), ["Broker A", "Broker B"]);
});

let cached; function P0() { return cached ??= build(); }
