// node --test tools/audit/
//
// Fully synthetic fixtures — invented ISINs (ZZ…), portfolios, prices and
// amounts. Every expected value is derived by hand in the comments.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeActivities, rebuildPositions, combineByIsin, investorFlows, xirr, xnpv,
  ttwror, flowsByDay, runAudit, toUnits, TOL,
} from './audit.mjs';

const Z1 = 'ZZ0000000001'; // split 2:1 on 2024-06-01, held in both portfolios
const Z2 = 'ZZ0000000002'; // bought and sold in portfolio A (tax refund on sale)
const SPLITS = [{ isin: Z1, exDate: '2024-06-01', ratio: 2 }];

const act = (id, type, date, isin, holdingId, shares, price, amount, fee, tax, amountNet, extra = {}) => ({
  id, type, datetime: `${date}T10:00:00.000Z`, asset: { assetIdentifierType: 'isin', isin }, holdingId,
  shares, price, amount, fee, tax, amountNet, currency: 'EUR', fx: null, ...extra,
});

// ---- Portfolio A --------------------------------------------------------
// Z1: buy 10 @ 100 (fee 5) → amountNet 1000 + 5 = 1005
//     buy 10 @ 120 (fee 5) → 1200 + 5 = 1205
//     split 2:1 → lots 20 @ 50 (cost 1000, fee 5) and 20 @ 60 (cost 1200, fee 5)
//     sell 30 @ 70, fee 6, tax 100 → amountNet 2100 − 6 − 100 = 1994
//       FIFO takes 20 from lot 1 (cost 1000, fee 5) + 10 from lot 2 (cost 600, fee 2.5)
//       realised gross = 2100 − 1600 = 500
//       buyAmountNet   = 1600 + 7.5 = 1607.5
//       realised net   = 1994 − 1607.5 = 386.5
//       remaining lot  = 10 @ 60, cost 600, fee 2.5
//       moving average: 40 sh / 2200 → avg 55; sell 30 → 2200 − 30 × 55 = 550
//     dividend 15, tax 4.13 → net 10.87
// Z2: buy 5 @ 200 (fee 10) → 1010
//     sell 5 @ 180, fee 10, tax −25 (refund) → 900 − 10 + 25 = 915
//       gross = 900 − 1000 = −100;  net = 915 − 1010 = −95
const PA = [
  act('a1', 'buy', '2024-01-10', Z1, 'hA1', 10, 100, 1000, 5, 0, 1005),
  act('a2', 'buy', '2024-03-10', Z1, 'hA1', 10, 120, 1200, 5, 0, 1205),
  act('a3', 'sell', '2024-09-10', Z1, 'hA1', 30, 70, 2100, 6, 100, 1994,
    { realizedGains: 500, buyAmountNet: 1607.5, realizedGainsNet: 386.5 }),
  act('a4', 'dividend', '2024-12-01', Z1, 'hA1', 10, 1.5, 15, 0, 4.13, 10.87),
  act('b1', 'buy', '2024-02-01', Z2, 'hA2', 5, 200, 1000, 10, 0, 1010),
  act('b2', 'sell', '2024-11-01', Z2, 'hA2', 5, 180, 900, 10, -25, 915,
    { realizedGains: -100, buyAmountNet: 1010, realizedGainsNet: -95 }),
];
// ---- Portfolio B (same ISIN Z1, bought after the split) ---------------------
// buy 4 @ 65 (fee 1) → 261;  buy 6 @ 80 (fee 1) → 481
// sell 5 @ 90, fee 1, tax 10 → 450 − 1 − 10 = 439
//   FIFO: 4 @ 65 (cost 260, fee 1) + 1 @ 80 (cost 80, fee 1/6)
//   gross = 450 − 340 = 110;  buyAmountNet = 341.1666…;  net = 439 − 341.1666… = 97.8333…
//   remaining lot 5 @ 80, cost 400, fee 5/6 = 0.8333…
//   moving average: 10 sh / 740 → avg 74; sell 5 → 370
// dividend 5, tax 1.25 → 3.75
const PB = [
  act('c1', 'buy', '2024-07-01', Z1, 'hB1', 4, 65, 260, 1, 0, 261),
  act('c2', 'buy', '2025-01-15', Z1, 'hB1', 6, 80, 480, 1, 0, 481),
  act('c3', 'sell', '2025-02-01', Z1, 'hB1', 5, 90, 450, 1, 10, 439),
  act('c4', 'dividend', '2025-03-01', Z1, 'hB1', 5, 1, 5, 0, 1.25, 3.75),
].map((a) => ({ ...a, subAccount: 'pfB::null' })); // portfolio only via subAccount

const payloads = () => [
  { file: 'activities-pfA.json', portfolioId: 'pfA', data: { portfolioId: 'pfA', activities: PA, cursor: null, totalActivities: PA.length } },
  { file: 'activities-pfB.json', portfolioId: null, data: PB },
  // the same row delivered twice (e.g. overlapping pages) must be dropped
  { file: 'activities.json', portfolioId: null, data: [{ portfolioId: 'pfA', activities: [PA[0]] }] },
];

const close = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a}`);

test('normalizeActivities: payload shapes, portfolio from subAccount, dedupe, amountNet rule', () => {
  const { activities, duplicates, incomplete } = normalizeActivities(payloads());
  assert.equal(activities.length, 10);
  assert.equal(duplicates, 1);
  assert.equal(incomplete.length, 0);
  assert.deepEqual([...new Set(activities.map((a) => a.portfolioId))].sort(), ['pfA', 'pfB']);
  // amountNet derived when missing: buy = 100 + 2 = 102, sell = 100 − 2 − (−5) = 103
  const n = normalizeActivities([{ data: [
    { id: 'x', type: 'buy', datetime: '2024-01-01T00:00:00Z', shares: 1, price: 100, amount: 100, fee: 2, tax: 0, asset: { isin: Z2 } },
    { id: 'y', type: 'sell', datetime: '2024-01-02T00:00:00Z', shares: 1, price: 100, amount: 100, fee: 2, tax: -5, asset: { isin: Z2 } },
  ] }]).activities;
  assert.equal(n[0].amountNet, 102);
  assert.equal(n[1].amountNet, 103);
  const partial = normalizeActivities([{ data: { portfolioId: 'p', activities: [], cursor: 'next', totalActivities: 3 } }]);
  assert.equal(partial.incomplete.length, 2);
});

test('rebuildPositions: split on ex-date, partial FIFO sell, moving average, tax refund', () => {
  const { activities } = normalizeActivities(payloads());
  const pos = rebuildPositions(activities, SPLITS);
  const a1 = pos.get('pfA|hA1');
  assert.equal(a1.shares, 10);
  assert.deepEqual(a1.splitsApplied, [{ exDate: '2024-06-01', ratio: 2 }]);
  close(a1.fifoCost, 600); close(a1.fifoFees, 2.5); close(a1.avgCostAustria, 550);
  close(a1.realizedGross, 500); close(a1.realizedNet, 386.5);
  assert.equal(a1.lots.length, 1);
  assert.deepEqual({ ...a1.lots[0], price: Math.round(a1.lots[0].price * 100) / 100 },
    { date: '2024-03-10', shares: 10, cost: 600, fee: 2.5, price: 60, portfolioId: 'pfA' });
  close(a1.dividends.net, 10.87); close(a1.dividends.tax, 4.13);

  const a2 = pos.get('pfA|hA2');
  assert.equal(a2.shares, 0);
  close(a2.realizedGross, -100); close(a2.realizedNet, -95); close(a2.sellTaxes, -25);

  const b1 = pos.get('pfB|hB1');
  assert.equal(b1.shares, 5);
  assert.deepEqual(b1.splitsApplied, []); // bought after the ex-date
  close(b1.fifoCost, 400); close(b1.fifoFees, 5 / 6); close(b1.avgCostAustria, 370);
  close(b1.realizedGross, 110); close(b1.realizedNet, 439 - 341 - 1 / 6);
  for (const p of pos.values()) assert.deepEqual(p.warnings, []);
});

test('rebuildPositions: a missing split shows up as an oversell warning', () => {
  const { activities } = normalizeActivities(payloads());
  const pos = rebuildPositions(activities, []);
  // without the split A holds 20 shares and sells 30
  assert.match(pos.get('pfA|hA1').warnings[0], /exceeds held 20/);
});

test('shares are tracked in 1e-8 units (no float drift)', () => {
  // 0.1 + 0.2 shares bought, 0.3 sold → exactly 0
  const acts = normalizeActivities([{ data: [
    act('f1', 'buy', '2024-01-01', Z2, 'h', 0.1, 10, 1, 0, 0, 1),
    act('f2', 'buy', '2024-01-02', Z2, 'h', 0.2, 10, 2, 0, 0, 2),
    act('f3', 'sell', '2024-01-03', Z2, 'h', 0.3, 10, 3, 0, 0, 3),
  ].map((a) => ({ ...a, subAccount: 'p::null' })) }]).activities;
  const p = rebuildPositions(acts, []).get('p|h');
  assert.equal(p.units, 0);
  assert.equal(p.shares, 0);
  assert.equal(toUnits(0.1) + toUnits(0.2), toUnits(0.3));
});

test('combineByIsin: same ISIN across two portfolios', () => {
  const { activities } = normalizeActivities(payloads());
  const c = combineByIsin(rebuildPositions(activities, SPLITS)).get(Z1);
  assert.equal(c.shares, 15); //                     10 (A) + 5 (B)
  close(c.fifoCost, 1000); //                         600 + 400
  close(c.avgCostAustria, 920); //                    550 + 370, per depot
  close(c.realizedNet, 386.5 + 97.8333333333, 1e-6); // 484.333…
  close(c.dividends.gross, 20); close(c.dividends.net, 14.62); close(c.dividends.tax, 5.38);
  assert.equal(c.parts.length, 2);
});

test('xirr: closed-form cases, Newton and bisection agree', () => {
  // −1000 → +1100 after 365 days: 1100/1000 − 1 = 10 %
  const one = [{ date: '2023-01-01', amount: -1000 }, { date: '2024-01-01', amount: 1100 }];
  close(xirr(one).rate, 0.10, 1e-9);
  // −1000 → +1210 after 730 days: (1.21)^(1/2) − 1 = 10 %
  const two = [{ date: '2022-01-01', amount: -1000 }, { date: '2024-01-01', amount: 1210 }];
  close(xirr(two).rate, 0.10, 1e-9);
  // −100 → +300 after 365 days: 200 %
  const big = [{ date: '2023-01-01', amount: -100 }, { date: '2024-01-01', amount: 300 }];
  close(xirr(big, { method: 'bisection' }).rate, 2, 1e-8);
  assert.equal(xirr(big, { method: 'bisection' }).method, 'bisection');
  // Newton from a hopeless guess falls back to bisection and still converges
  const fb = xirr(one, { guess: -0.9999999 });
  close(fb.rate, 0.10, 1e-8);
  assert.equal(xirr([{ date: '2023-01-01', amount: 100 }]), null);
});

test('investorFlows + xirr on the synthetic portfolios', () => {
  const { activities } = normalizeActivities(payloads());
  const flows = investorFlows(activities, { date: '2025-03-10', value: 1500 });
  // buys −amountNet, sells/dividends +amountNet, terminal +value
  assert.deepEqual(flows.map((f) => f.amount), [-1005, -1010, -1205, -261, 1994, 915, 10.87, -481, 439, 3.75, 1500]);
  const n = xirr(flows), b = xirr(flows, { method: 'bisection' });
  close(n.rate, b.rate, 1e-8);
  close(xnpv(n.rate, flows), 0, 1e-6);
});

test('ttwror: flows are neutralised', () => {
  // 1000 → 1100 (+10 %); then +500 invested, value 1700:
  //   (1700 − 500) / 1100 = 1.0909…; 1.1 × 1.0909… = 1.2 → 20 %
  const pts = [{ date: '2024-01-01', value: 1000 }, { date: '2024-01-02', value: 1100 }, { date: '2024-01-03', value: 1700 }];
  close(ttwror(pts, new Map([['2024-01-03', 500]])).pct, 20, 1e-9);
  // flowsByDay: buy +amountNet, sell −amountNet
  const { activities } = normalizeActivities(payloads());
  const f = flowsByDay(activities);
  assert.equal(f.get('2024-01-10'), 1005);
  assert.equal(f.get('2024-09-10'), -1994);
});

// ---- End-to-end on a consistent synthetic snapshot ---------------------------
function fixture() {
  const { activities } = normalizeActivities(payloads());
  const flows = investorFlows(activities, { date: '2025-03-10', value: 1500 });
  const parqetXirr = xirr(flows, { method: 'bisection' }).rate * 100;
  const q = { datetime: '2025-03-10T12:00:00.000Z' };
  const holding = (id, pid, isin, shares, pv, cv, rg, rn) => ({
    id, subAccount: `${pid}::null`, asset: { isin }, quote: q,
    position: { shares, purchaseValue: pv, currentValue: cv, isSold: shares === 0 },
    performance: { realizedGains: { inInterval: { gainGross: rg, gainNet: rn } } },
  });
  const raw = {
    actPayloads: payloads(),
    names: new Map([['pfA', 'Broker A'], ['pfB', 'Broker B']]),
    perfByPortfolio: new Map(),
    performance: {
      interval: { start: '2024-01-10', end: '2025-03-10' },
      performance: {
        kpis: { inInterval: { xirr: parqetXirr, ttwror: 12.34 } },
        fees: { inInterval: { fees: 39 } }, //          5+5+6+10+10+1+1+1
        taxes: { inInterval: { taxes: 90.38 } }, //     100 + 4.13 − 25 + 10 + 1.25
        // unrealized gross = 1500 − 1000; net = gross − remaining lot fees (2.5 + 0.8333)
        unrealizedGains: { inInterval: { gainGross: 500, gainNet: 500 - 2.5 - 5 / 6 } },
        realizedGains: { inInterval: { gainGross: 510, gainNet: 386.5 - 95 + 97 + 5 / 6 } },
        dividends: { inInterval: { gainGross: 20, gainNet: 14.62, taxes: 5.38, fees: 0 } },
        valuation: { atIntervalStart: 0, atIntervalEnd: 1500 },
      },
      holdings: [
        holding('hA1', 'pfA', Z1, 10, 600, 1000, 500, 386.5),
        holding('hA2', 'pfA', Z2, 0, 0, 0, -100, -95),
        holding('hB1', 'pfB', Z1, 5, 400, 500, 110, 97 + 5 / 6),
      ],
    },
    charts: {
      interval: { end: '2025-03-10' },
      charts: [
        { mark: 'bod', date: '2025-03-08T00:00:00.000Z', values: { history: 0, capitalHistory: 0 } },
        { mark: 'eod', date: '2025-03-08T00:00:00.000Z', values: { history: 1400, capitalHistory: 1000 } },
        { mark: 'eod', date: '2025-03-09T00:00:00.000Z', values: { history: 1450, capitalHistory: 1000 } },
        { mark: 'most_recent', date: '2025-03-10T00:00:00.000Z', values: { history: 1500, capitalHistory: 1000 } },
      ],
    },
    ranges: null,
  };
  const L = (d, type, isin, account, shares, price, gross, fee, tax, net) => ({ d, type, isin, account, shares, price, gross, fee, tax, net });
  const snapshot = {
    meta: {
      asOf: '2025-03-10T12:00:00.000Z', convertedAt: '2025-03-10T12:05:00.000Z',
      portfolio: { accounts: [{ id: 'pfA', name: 'Broker A' }, { id: 'pfB', name: 'Broker B' }] },
    },
    totals: {
      // unrealised is net of the open lots' buy fees: 1500 − 1000 − (2.5 + 0.8333) = 496.67
      value: 1500, invested: 1000, unrealized: 496.67, realized: 389.33,
      dividendsGross: 20, dividendsNet: 14.62, dividendsTax: 5.38, fees: 39, taxes: 90.38,
      xirr: Math.round(parqetXirr * 100) / 100, ttwror: 12.34,
      totalGain: 900.62, //                                496.67 + 389.33 + 14.62
    },
    holdings: [{
      isin: Z1, shares: 15, price: 100, value: 1500, cost: 1000, avg: 66.67, unrealized: 496.67,
      realized: 484.33, dividendsNet: 14.62, costAustria: 920,
      splits: [{ exDate: '2024-06-01', ratio: 2 }],
      accounts: [{ name: 'Broker A', shares: 10, cost: 600 }, { name: 'Broker B', shares: 5, cost: 400 }],
      lots: [
        { date: '2024-03-10', shares: 10, price: 60, cost: 600, fee: 2.5, account: 'Broker A' },
        { date: '2025-01-15', shares: 5, price: 80, cost: 400, fee: 0.83, account: 'Broker B' },
      ],
    }],
    closed: [{ isin: Z2, realizedNet: -95, dividendsNet: 0 }],
    ledger: [
      L('2024-01-10', 'BUY', Z1, 'Broker A', 10, 100, 1000, 5, 0, -1005),
      L('2024-03-10', 'BUY', Z1, 'Broker A', 10, 120, 1200, 5, 0, -1205),
      L('2024-09-10', 'SELL', Z1, 'Broker A', 30, 70, 2100, 6, 100, 1994),
      L('2024-12-01', 'DIVIDEND', Z1, 'Broker A', null, null, 15, 0, 4.13, 10.87),
      L('2024-02-01', 'BUY', Z2, 'Broker A', 5, 200, 1000, 10, 0, -1010),
      L('2024-11-01', 'SELL', Z2, 'Broker A', 5, 180, 900, 10, -25, 915),
      L('2024-07-01', 'BUY', Z1, 'Broker B', 4, 65, 260, 1, 0, -261),
      L('2025-01-15', 'BUY', Z1, 'Broker B', 6, 80, 480, 1, 0, -481),
      L('2025-02-01', 'SELL', Z1, 'Broker B', 5, 90, 450, 1, 10, 439),
      L('2025-03-01', 'DIVIDEND', Z1, 'Broker B', null, null, 5, 0, 1.25, 3.75),
    ],
    series: [['2025-03-08', 1400, 1000], ['2025-03-09', 1450, 1000], ['2025-03-10', 1500, 1000]],
  };
  return { raw, snapshot };
}

const statusOf = (report, name) => report.rows.find((r) => r.name.startsWith(name))?.status;

test('runAudit: a consistent synthetic snapshot has no FAIL and no WARN', () => {
  const { raw, snapshot } = fixture();
  const { report } = runAudit({ raw, snapshot, splits: SPLITS, now: new Date('2025-03-11T00:00:00Z') });
  const bad = report.rows.filter((r) => r.status === 'FAIL' || r.status === 'WARN');
  assert.deepEqual(bad.map((r) => `${r.name}: ${r.detail} ${r.items.join('; ')}`), []);
  assert.equal(statusOf(report, 'Shares per ISIN × portfolio'), 'PASS');
  assert.equal(statusOf(report, 'Moving avg'), 'PASS');
  assert.equal(statusOf(report, 'Per sell'), 'PASS');
});

test('runAudit: catches a wrong cost, a duplicated series date, a missing split and stale data', () => {
  const { raw, snapshot } = fixture();
  snapshot.holdings[0].cost = 1001;
  snapshot.series.unshift(['2025-03-08', 0, 0]);
  const r1 = runAudit({ raw, snapshot, splits: SPLITS, now: new Date('2025-03-20T00:00:00Z') }).report;
  assert.equal(statusOf(r1, 'FIFO (fees excl.) per ISIN'), 'FAIL');
  assert.equal(statusOf(r1, 'Dates strictly increasing'), 'FAIL');
  assert.equal(statusOf(r1, 'Newest quote age'), 'WARN'); // 9.5 days > 3
  assert.ok(r1.failed);

  const f = fixture();
  const r2 = runAudit({ raw: f.raw, snapshot: f.snapshot, splits: [], now: new Date('2025-03-11T00:00:00Z') }).report;
  assert.equal(statusOf(r2, 'Rebuild consistent'), 'FAIL');
  assert.equal(statusOf(r2, 'Shares per holding'), 'FAIL');
});

test('runAudit: flags Parqet-style double-counted buy fees in unrealized net', () => {
  const { raw, snapshot } = fixture();
  // Parqet deducts ALL lifetime buy fees of open holdings: A 5+5, B 1+1 = 12,
  // instead of the remaining lots' 3.3333 → Δ 8.6667
  raw.performance.performance.unrealizedGains.inInterval.gainNet = 500 - 12;
  snapshot.totals.unrealized = 488;
  snapshot.totals.totalGain = 488 + 389.33 + 14.62;
  const { report } = runAudit({ raw, snapshot, splits: SPLITS, now: new Date('2025-03-11T00:00:00Z') });
  assert.equal(statusOf(report, 'Parqet unrealized gross−net'), 'WARN');
  assert.match(report.rows.find((r) => r.name.startsWith('Parqet unrealized')).detail, /Δ 8\.67/);
  assert.equal(statusOf(report, 'totals.unrealized = Σ holdings unrealized'), 'FAIL');
});

test('runAudit: cash-account mirrors are verified, then left out of every other check', () => {
  const { raw, snapshot } = fixture();
  // Broker B pays c1 (261) from a cash account: Parqet books it again as cpa_referencing_<id>
  // on the cash holding, whose balance (−261) is part of Parqet's valuation and capital line.
  const pb = raw.actPayloads[1].data.map((a) => (a.id === 'c1' ? { ...a, id: 'cpa_c1' } : a));
  const trade = pb.find((a) => a.id === 'cpa_c1');
  const mirror = { ...trade, id: 'cpa_referencing_c1', holdingId: 'hB-cash', holdingAssetType: 'cash', shares: 261, price: 1 };
  raw.actPayloads[1] = { ...raw.actPayloads[1], data: [...pb, mirror] };
  raw.performance.holdings.push({
    id: 'hB-cash', subAccount: 'pfB::null', asset: { type: 'cash' },
    position: { shares: -261, purchaseValue: 261, currentValue: -261, isSold: false },
    performance: { realizedGains: { inInterval: { gainGross: 0, gainNet: 0 } } },
  });
  raw.performance.performance.valuation.atIntervalEnd = 1500 - 261;
  const last = raw.charts.charts[raw.charts.charts.length - 1].values;
  Object.assign(last, { history: 1500 - 261, capitalHistory: 1000 - 261 });
  snapshot.cash = [{ account: 'Broker B', name: 'Cash', value: -261 }];
  snapshot.totals.value = 1500 - 261;
  snapshot.series[snapshot.series.length - 1] = ['2025-03-10', 1500 - 261, 1000 - 261];
  const now = new Date('2025-03-11T00:00:00Z');
  const ok = runAudit({ raw, snapshot, splits: SPLITS, now }).report;
  const bad = ok.rows.filter((r) => r.status === 'FAIL' || r.status === 'WARN');
  assert.deepEqual(bad.map((r) => `${r.name}: ${r.detail} ${r.items.join('; ')}`), []);
  assert.equal(statusOf(ok, 'Cash-account bookings'), 'PASS');
  assert.equal(statusOf(ok, 'Cash balance'), 'PASS');
  assert.equal(statusOf(ok, 'XIRR (newton'), 'PASS'); // cash balance stays out of the terminal value

  mirror.amountNet = 250; // a mirror that no longer matches its trade
  assert.equal(statusOf(runAudit({ raw, snapshot, splits: SPLITS, now }).report, 'Cash-account bookings'), 'FAIL');
});

test('tolerances are documented constants', () => {
  assert.equal(TOL.money, 0.01);
  assert.equal(TOL.staleDays, 3);
});
