/* Demo snapshot — fictional investor, same schema as tools/parqet-import/convert.mjs output.
   Committed on purpose: the public repo renders this when no portfolio.local.js exists. */
(() => {
  const r2 = n => Math.round(n * 100) / 100;
  const H = [
    { id: "d1", isin: "IE00BK5BQT80", name: "FTSE All-World", fullName: "Vanguard FTSE All-World UCITS ETF Acc", kind: "ETF", price: 128.90, dayPct: 0.40,
      lots: [["2021-02-01", 60, 88.20], ["2021-08-02", 55, 96.40], ["2022-03-01", 70, 92.15], ["2023-01-02", 85, 101.30], ["2024-04-02", 72, 112.85], ["2025-06-02", 70, 121.40]] },
    { id: "d2", isin: "IE00B4L5Y983", name: "Core MSCI World", fullName: "iShares Core MSCI World UCITS ETF", kind: "ETF", price: 95.62, dayPct: 0.59,
      lots: [["2021-03-15", 120, 64.80], ["2022-10-11", 85, 71.45], ["2024-05-08", 80, 104.90]] },
    { id: "d3", isin: "NL0010273215", name: "ASML", fullName: "ASML Holding NV", kind: "Stock", price: 702.10, dayPct: 3.10,
      lots: [["2022-06-22", 20, 512.40], ["2026-08-18", 18, 718.80]] },
    { id: "d4", isin: "DE0007164600", name: "SAP", fullName: "SAP SE", kind: "Stock", price: 236.40, dayPct: 1.40,
      lots: [["2022-11-04", 95, 148.30]] },
    { id: "d5", isin: "AT0000743059", name: "OMV", fullName: "OMV AG", kind: "Stock", price: 46.12, dayPct: -0.44,
      lots: [["2022-02-03", 200, 38.90], ["2023-09-27", 140, 46.06]] },
  ];
  const holdings = H.map(h => {
    const lots = h.lots.map(([date, shares, price]) => ({ date, shares, price, cost: r2(shares * price), fee: 1.5 }));
    const shares = lots.reduce((s, l) => s + l.shares, 0), cost = r2(lots.reduce((s, l) => s + l.cost, 0));
    const value = r2(shares * h.price), dayAbs = r2(value - value / (1 + h.dayPct / 100));
    return { id: h.id, isin: h.isin, name: h.name, fullName: h.fullName, kind: h.kind, shares, price: h.price, value, cost,
      avg: r2(cost / shares), unrealized: r2(value - cost), unrealizedPct: r2((value / cost - 1) * 100), realized: 0, dividendsNet: 0,
      dayAbs, dayPct: h.dayPct, quote: { exchange: "xetra", at: "2026-10-09T15:35:00.000Z" }, first: lots[0].date,
      trades: lots.length, splits: [], costAustria: cost, lots };
  }).sort((a, b) => b.value - a.value);

  const closed = [
    { isin: "FI0009000681", name: "Nokia", kind: "Stock", realizedNet: 412.80, dividendsNet: 18.40, first: "2021-03-02", last: "2024-05-14", trades: 3 },
    { isin: "AT0000937503", name: "voestalpine", kind: "Stock", realizedNet: -286.10, dividendsNet: 41.20, first: "2022-05-19", last: "2025-07-15", trades: 2 },
    { isin: "IE00BDBRDM35", name: "Core Global Aggregate Bond", kind: "ETF", realizedNet: 96.35, dividendsNet: 0, first: "2023-01-12", last: "2026-02-10", trades: 2 },
  ];

  const ledger = [];
  for (const h of holdings) for (const l of h.lots)
    ledger.push({ d: l.date, type: "BUY", name: h.name, isin: h.isin, shares: l.shares, price: l.price, gross: l.cost, fee: 1.5, tax: 0, net: r2(-(l.cost + 1.5)) });
  [["2025-06-04", "OMV", 238.00], ["2026-06-03", "OMV", 255.00], ["2025-05-21", "SAP", 223.25], ["2026-05-20", "SAP", 237.50]]
    .forEach(([d, n, g]) => ledger.push({ d, type: "DIVIDEND", name: n, isin: holdings.find(h => h.name === n).isin, shares: null, price: null,
      gross: g, fee: 0, tax: r2(g * 0.275), net: r2(g * 0.725) }));
  ledger.sort((a, b) => b.d.localeCompare(a.d));

  const value = r2(holdings.reduce((s, h) => s + h.value, 0)), invested = r2(holdings.reduce((s, h) => s + h.cost, 0));
  const anchors = [["2021-02-01", 5300, 5300], ["2021-09-01", 12200, 11000], ["2022-03-01", 26500, 24900], ["2022-10-03", 31500, 36000],
    ["2023-04-03", 58200, 56100], ["2023-10-02", 64800, 62300], ["2024-05-06", 92400, 82000], ["2025-01-06", 103600, 87000],
    ["2025-06-02", 104900, 95500], ["2026-01-05", 121300, 103400], ["2026-08-18", 130600, invested], ["2026-10-09", value, invested]];
  const series = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const [d0, v0, c0] = anchors[i], [d1, v1, c1] = anchors[i + 1];
    const t0 = Date.parse(d0), t1 = Date.parse(d1);
    for (let t = t0; t < t1; t += 7 * 864e5) {
      const f = (t - t0) / (t1 - t0), k = series.length;
      series.push([new Date(t).toISOString().slice(0, 10), r2((v0 + (v1 - v0) * f) * (1 + 0.014 * Math.sin(k * 1.7) + 0.008 * Math.sin(k * 0.5))), r2(c0 + (c1 - c0) * f)]);
    }
  }
  series.push([anchors.at(-1)[0], value, invested]);

  const unrealized = r2(value - invested), realized = r2(closed.reduce((s, c) => s + c.realizedNet, 0));
  const divNet = r2(ledger.filter(l => l.type === "DIVIDEND").reduce((s, l) => s + l.net, 0));
  window.PORTFOLIO_DEMO = {
    meta: { source: "demo", isDemo: true, currency: "EUR", portfolio: { id: "demo", name: "Demo depot" }, since: "2021-02-01", asOf: "2026-10-09T15:35:00.000Z" },
    totals: { value, invested, unrealized, realized, dividendsNet: divNet, dividendsGross: r2(divNet / 0.725), fees: 39, taxes: 312.4,
      xirr: 11.8, ttwror: 63.4, totalGain: r2(unrealized + realized + divNet),
      dayAbs: r2(holdings.reduce((s, h) => s + h.dayAbs, 0)), dayPct: 0.84, costBasisMethod: "FIFO, fees excluded" },
    ranges: { "1M": { ttwror: 2.1, xirr: 0, gain: 2950 }, "6M": { ttwror: 8.4, xirr: 17.1, gain: 10240 }, YTD: { ttwror: 12.2, xirr: 16.0, gain: 14100 },
      "1Y": { ttwror: 15.3, xirr: 15.1, gain: 17800 }, "5Y": { ttwror: 63.4, xirr: 11.8, gain: r2(unrealized + realized + divNet) }, MAX: { ttwror: 63.4, xirr: 11.8, gain: r2(unrealized + realized + divNet) } },
    holdings, closed, ledger, series,
    sync: { source: "Demo", activities: ledger.length, counts: {}, holdingsTotal: holdings.length + closed.length, holdingsOpen: holdings.length,
      holdingsClosed: closed.length, reconcile: holdings.map(h => ({ isin: h.isin, name: h.name, ok: true, matches: ["FIFO, fees excluded"], splits: [] })) },
  };
})();
