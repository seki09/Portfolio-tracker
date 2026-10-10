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
   | `portfolios.json` | `parqet_list_portfolios` — **all** portfolios; turns on the combined account |
   | `activities-<portfolioId>.json` | `parqet_get_activities` per portfolio (all pages; partial pages are rejected) |
   | `activities.json` | single-portfolio layout only, instead of the two rows above |
   | `performance.json` | `parqet_get_performance` (interval `max`, `portfolioIds` = all) |
   | `overview-charts.json` | `parqet_query_portfolio` view `overview`, `includeCharts: true` |
   | `portfolio.json` | `parqet_list_portfolios` entry for the portfolio (optional; display name) |
   | `day.json` | raw `parqet_get_performance` interval `1d`, all portfolios (optional; day change) |
   | `ranges.json` | `{ "1M": <overview payload>, "6M": …, "YTD": …, "1Y": …, "5Y": …, "MAX": … }` from `parqet_query_portfolio` view `overview` (optional; range returns) |

   Performance, charts, day and ranges are requested with **all** portfolio IDs, so Parqet
   aggregates them. The connector only sees portfolios it was granted when it was connected
   — a portfolio added later in Parqet must be granted by reconnecting the connector.

   The Parqet Connect API returns the same shapes, so the production adapter
   swaps the capture step and keeps everything below.

2. **Convert**

   ```sh
   node tools/parqet-import/convert.mjs            # → prototype/data/portfolio.local.js
   ```

3. **Open** `prototype/index.html`. It renders `portfolio.local.js` when present
   and falls back to the committed demo snapshot otherwise.

## One combined account

With several portfolios, the same security held at several brokers becomes **one
position**: shares, value and cost are summed, each broker's lots stay tagged with their
account, and the Austrian KESt basis is summed per depot (it is computed per depot). A
security sold out at one broker but still held at another stays one open position that
carries the realised result. Every per-broker holding is still reconciled on its own.
Tested on a synthetic two-broker portfolio: `node --test tools/parqet-import/*.test.mjs`.

### Cash accounts

Some brokers (Trade Republic) come with a cash holding — the settlement account. Parqet
books every trade paid through it twice: once on the security and once as a
`cpa_referencing_<id>` mirror on the cash holding. The converter keeps the security side
only, lists the balance under `cash` (`[{account, name, value}]`, sum in `totals.cash`) and
keeps it in `totals.value`, exactly as Parqet's valuation does. Gains and the money-in/out
self-check cover the securities only; the app weights positions by securities value. A
negative balance means deposits to that account aren't recorded in Parqet. Any other kind
of cash-account booking (deposit, withdrawal) stops the import until a cash ledger exists.

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
