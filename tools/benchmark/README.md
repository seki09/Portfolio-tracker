# Benchmark: portfolio vs MSCI World

Builds the data behind the private "Portfolio vs MSCI World" dashboard (claude.ai Dashboard
artifact type). All inputs and outputs are personal data and stay in the gitignored
`imports/` folder. Background and method: [docs/STATUS.md](../../docs/STATUS.md#benchmark-dashboard-toolsbenchmark).

| File | Does |
| --- | --- |
| `extract-msci-quotes.mjs` | Collects IE00B4L5Y983 quotes from Parqet results in a session transcript → `imports/benchmark/msci-world.json` |
| `build-dashboard-data.mjs` | Raw Parqet chart and range payloads plus those quotes → `imports/benchmark/dashboard/*.json` |
| `dashboard-page.html` | The dashboard page (`files/index.html` in the artifact's store); no numbers, everything from the datasets `portfolio_history`, `msci_monthly` and `period_returns` |

```sh
node tools/benchmark/extract-msci-quotes.mjs <session.jsonl> imports/benchmark/msci-world.json
node tools/benchmark/build-dashboard-data.mjs
```

The ETF prices for the 1M/6M/YTD/1Y/5Y window starts are constants in
`build-dashboard-data.mjs` (public market data as of the 2026-10-10 sync). Replace them when
refreshing.
