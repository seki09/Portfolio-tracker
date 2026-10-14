# Project status: paused (2026-10-14)

The tracker is shut down and not being developed further for now. This page is the
hand-over: what exists, how it fits together, what was learned, and how to pick it up again.
It contains no personal figures. Real data lives only in gitignored files and in the owner's
private claude.ai artifacts.

## What was shut down

| Piece | State |
| --- | --- |
| Routine **Portfolio sync & check** (daily, Mon–Fri 21:30 UTC) | Disabled, not deleted. Prompt saved in [routines/sync-and-check.md](routines/sync-and-check.md) |
| Routine **Portfolio review & ideas** (weekly, Sun 07:00 UTC) | Disabled, not deleted. Prompt saved in [routines/weekly-review.md](routines/weekly-review.md) |
| Private app artifact (the prototype with real data, audit status, insights) | Left in place as it was on 2026-10-10; no longer refreshed |
| Private dashboard artifact "Portfolio vs MSCI World" | Left in place as of the 2026-10-10 sync; no longer refreshed |

Both artifacts are in the owner's claude.ai artifact gallery. Their links are deliberately not
in this public repository. Re-enabling a routine in claude.ai → Routines resumes it as it was.

## What exists in this repository

| Path | What it is | Status |
| --- | --- | --- |
| [docs/ux-proposal.md](ux-proposal.md), [implementation-plan.md](implementation-plan.md), [deployment-portability.md](deployment-portability.md) | Product and architecture design for the full self-hosted app (Next.js, PostgreSQL, Drizzle; Netlify-portable) | Design only; the full app was never started |
| [prototype/index.html](../prototype/index.html) | Mobile-first single-file app (Material 3, monochrome): overview, holdings with lots, activity ledger, import flow, audit status, insights. Renders `prototype/data/portfolio.local.js` if present, else the fictional demo | Working |
| [prototype/importers/flatex-at-pdf.js](../prototype/importers/flatex-at-pdf.js) | In-browser flatex.at PDF statement parser, with tests | Working; `node --test prototype/importers/*.test.mjs` |
| [tools/parqet-import/](../tools/parqet-import/) | Parqet → snapshot converter: rebuilds lots from raw activities, applies splits, combines several portfolios into one account, handles broker cash accounts, reconciles against Parqet | Working; `node --test tools/parqet-import/` |
| [tools/audit/](../tools/audit/) | Independent audit of the snapshot against Parqet (positions, values, gains, cash flows, XIRR, ranges) | Working; last real run passed with one warning |
| [tools/benchmark/](../tools/benchmark/) | MSCI World benchmark data and the dashboard page | Working, manual (see below) |
| [docs/agents.md](agents.md) | How the two routines worked and what they guaranteed | Reference |

## Data flow (as it ran)

```
Parqet MCP connector (read-only)
  └─ raw payloads ─────────────► imports/parqet/raw/*.json            (gitignored)
       └─ tools/parqet-import/convert.mjs ─► prototype/data/portfolio.local.js  (gitignored)
            └─ tools/audit/audit.mjs  (must pass before publishing)
                 └─ publish prototype + snapshot to the private app artifact
                      └─ artifact data store: audits/latest, audits/<date>, insights/<date>-<n>
```

The three broker portfolios in Parqet (DADAT, flatex, Trade Republic) were combined into one
account; each holding keeps its sub-account.

## Benchmark dashboard (tools/benchmark)

- `extract-msci-quotes.mjs` collects iShares Core MSCI World (IE00B4L5Y983) prices from
  Parqet results in a session transcript. Parqet has no price-history tool: one
  `parqet_get_performance` call per month over a portfolio holding the ETF returns the
  previous month-end close (`startQuote`) and this month-end close (`quote`), so calling every
  other month covers all month-ends. About 30 calls cover Dec 2017 to today.
- `build-dashboard-data.mjs` turns the raw Parqet chart and range payloads plus those
  prices into three JSON files in `imports/benchmark/dashboard/` (gitignored).
- `dashboard-page.html` is the page for the claude.ai **Dashboard** artifact type. It holds
  no numbers. Everything comes from the three uploaded files and four calculations
  (month-end series, headline figures, period table, calendar years).
- Method: both lines are time-weighted (Parqet TTWROR for the portfolio, ETF price change
  for the index, which is accumulating). Period windows use the ETF price from the same
  absolute Parqet interval. Two month-ends carry a trade price instead of a close.

## What was learned about Parqet (worth keeping)

- **Cash accounts**: a broker cash holding (e.g. Trade Republic's settlement account) mirrors
  every trade as a `cpa_referencing_<id>` booking that points at activity `cpa_<id>`. Those
  mirrors must be excluded from trades; any other cash booking is unsupported and stops the
  import on purpose.
- Parqet's **total value includes cash**, but **XIRR leaves the cash balance out** of the
  opening and terminal values, and invested capital counts a cash holding as
  `sign(shares) × purchaseValue`.
- `startQuote` is the last close **before** the interval start; `quote` is the last close up
  to the end. Quotes with exchange `activity` are trade prices, and `fallbackexchange` with
  price 0 means no quote.
- The overview chart (`includeCharts`) is sampled weekly in early years and daily recently;
  values are `history`, `capitalHistory`, `perfHistory`, `perfHistoryUnrealized`, `ttwror`
  and `drawdown`.
- The connector only sees portfolios granted when it was connected. A new Parqet portfolio
  needs a reconnect with it selected.
- Routines created from a coding session can't carry connectors in this organisation. The
  connector has to be attached to the routine in claude.ai.
- Yahoo Finance and stooq are blocked by the cloud environment's network policy, so Parqet
  was the only price source.

## Rules that must survive a restart

- The repository is **public**: `imports/`, `*.local.js` and `*.local.json` stay gitignored.
  Grep the staged diff for personal figures before every commit.
- Read-only towards money: never call `parqet_add_activities`, `parqet_create_portfolio` or
  `parqet_create_holding`, and never place, suggest or automate orders.
- Insights are observations, not personal financial advice. Past leveraged and derivative
  trades are ignored at the owner's request.
- Timestamps written anywhere come from `date -u`, never from estimation.

## Picking it up again

1. Re-enable the two routines in claude.ai → Routines. Attach the Parqet connector to
   *sync & check* if it is no longer attached. Or recreate them from the saved prompts.
2. Or run it by hand in a session with the Parqet connector: capture payloads as in
   [routines/sync-and-check.md](routines/sync-and-check.md) steps 1–3, then
   `node tools/parqet-import/convert.mjs && node tools/audit/audit.mjs`.
3. Refresh the dashboard: re-collect MSCI prices for the new months, run
   `node tools/benchmark/build-dashboard-data.mjs`, upload the three files to the dashboard
   artifact, and point its datasets at the new uploads.
4. The local data from the last session (`imports/`, `portfolio.local.js`) is gone once the
   cloud container is reclaimed. It is not needed, because everything can be pulled again
   from Parqet. The last published snapshot also stays readable in the app artifact.

Open decisions from the design phase (full app stack, first brokers, cost-basis method) are
still listed at the end of each design document.
