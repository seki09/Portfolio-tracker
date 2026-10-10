# Parqet import

Turns raw Parqet payloads into the snapshot the prototype renders. This is the
working prototype of the `parqet-api` adapter in
[implementation-plan.md §4.1](../../docs/implementation-plan.md).

> **Privacy.** Everything this tool reads and writes is personal financial data.
> `imports/` and `*.local.js` are gitignored, and this repository is public —
> never move these files to a tracked path.

## Workflow

1. **Capture** — with the Parqet connector attached to Claude, ask it to *sync
   Parqet*. It saves four payloads to `imports/parqet/raw/`:

   | File | Parqet call |
   | --- | --- |
   | `activities.json` | `parqet_get_activities` (all pages; the converter rejects a partial page) |
   | `performance.json` | `parqet_get_performance` (interval `max`) |
   | `overview-charts.json` | `parqet_query_portfolio` view `overview`, `includeCharts: true` |
   | `portfolio.json` | `parqet_list_portfolios` entry for the portfolio (optional; display name) |
   | `day.json` | `parqet_get_performance` interval `1d` (optional; per-position day change) |
   | `ranges.json` | `parqet_query_portfolio` overview per interval 1m…max (optional; range returns) |

   The Parqet Connect API returns the same shapes, so the production adapter
   swaps the capture step and keeps everything below.

2. **Convert**

   ```sh
   node tools/parqet-import/convert.mjs            # → prototype/data/portfolio.local.js
   ```

3. **Open** `prototype/index.html`. It renders `portfolio.local.js` when present
   and falls back to the committed demo snapshot otherwise.

## What the converter checks

Positions and lots are **rebuilt from raw activities**, not copied from Parqet's
summary, then reconciled against Parqet's reported shares and cost basis. It
exits non-zero if any position fails to reconcile.

Two things the first real import surfaced:

- **Parqet's activity feed is not split-adjusted.** A buy made before a 20:1 split
  arrives in pre-split shares and prices; Parqet applies the split internally. Splits live in
  [`corporate-actions.json`](corporate-actions.json) (public market data) and are
  applied on their ex-date. A missing split shows up as *"sells N more shares than
  held"* — add the split and re-run.
- **Parqet's cost basis is FIFO with fees excluded.** The converter computes all
  four variants — {FIFO, moving average} × {fees in, fees out} — and reports which
  one matches. For Austrian KESt the relevant basis for privately held securities
  is **moving average, fees excluded**, which can differ materially from Parqet's
  figure; the snapshot carries both (`cost` and `costAustria`).
