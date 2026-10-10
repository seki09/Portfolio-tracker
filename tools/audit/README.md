# Portfolio audit

An **independent** check of the snapshot that `tools/parqet-import/convert.mjs`
produces. The audit recomputes every figure from the raw Parqet activities with
its own code: none of the converter's logic is shared, only the snapshot's output
schema. A bug in the converter therefore cannot confirm itself.

> **Privacy.** The audit reads gitignored files (`imports/parqet/raw/`,
> `prototype/data/portfolio.local.js`) at runtime and prints to your terminal
> only. Nothing in this folder contains personal data; the test fixtures are
> invented (ISINs `ZZ…`, made-up portfolios and prices).

## Run

```sh
node tools/audit/audit.mjs             # PASS/FAIL table, exit 1 on any FAIL
node tools/audit/audit.mjs --verbose   # list every item of every check
node tools/audit/audit.mjs --json      # machine-readable rows
node --test tools/audit/*.test.mjs     # synthetic tests of the calculations
```

Options: `--raw DIR` (default `imports/parqet/raw`), `--snapshot FILE`
(default `prototype/data/portfolio.local.js`), `--splits FILE` (default
`tools/parqet-import/corporate-actions.json`), `--now ISO` (for freshness).

## Inputs

| File | Used for |
| --- | --- |
| `activities.json`, `activities-<portfolioId>.json` | all raw activities; any mix of `{portfolioId, activities}`, an array of such payloads, or a bare array. Rows are deduplicated by `id`; the portfolio is taken from the payload, else from the `subAccount` prefix |
| `performance.json` | Parqet's account-level figures and per-holding positions (all portfolios) |
| `performance-<portfolioId>.json` | optional per-portfolio payloads (adds a per-portfolio XIRR check) |
| `overview-charts.json` | Parqet's value / capital series |
| `ranges.json` | Parqet's per-range returns |
| `portfolios.json`, `portfolio.json` | portfolio names (to match the snapshot's `account` names) |

Positions are rebuilt **per Parqet holding** (portfolio × security) and then
summed **per ISIN**, so the same security held at several brokers is checked
both ways.

## How the audit computes

* **Shares** in integer units of 1e‑8, so splits and partial sells cannot drift.
* **Splits** from the public splits table, applied on the ex-date: activities
  dated on/after the ex-date are already post-split, earlier lots are multiplied.
* **Day** = UTC date of the activity timestamp — Parqet's convention.
* **FIFO** cost basis, fees excluded (lot cost = `amount`); each lot also carries
  its buy fee (+ buy tax) so realised *net* can be derived.
* **Moving average**, fees excluded, per depot (Austrian KESt basis); the
  combined figure is the sum over depots.
* **Realised gross** = sell `amount` − FIFO cost.
* **Realised net** = sell `amountNet` − (FIFO cost + pro-rata buy fees of the
  sold lots). This is Parqet's definition, read off the raw data: every sell row
  carries `buyAmountNet` and `realizedGainsNet = amountNet − buyAmountNet`.
* **XIRR**: Newton, falling back to bisection; ACT/365 on UTC days; flows from
  the investor's view: buy / transfer-in −`amountNet`, sell / dividend /
  interest / transfer-out +`amountNet`, fees_taxes −|`amountNet`|, plus the
  terminal value on the interval end. This reproduces Parqet to < 1e‑4 pp.
  Range XIRRs treat the range's opening value as invested on the **day before**
  the range start (also < 0.005 pp). Deposits / withdrawals are not flows here.
  Cash-account balances are left out of the terminal and opening values — that is
  what Parqet does (< 1e‑4 pp with, 0.014 pp off without, on real data).
* **TTWROR**: chained daily returns `(V_t − F_t) / V_{t−1}` with `F_t` = net
  inflow of the day. Only feasible where Parqet's chart series is daily and has a
  point on the day before the range start — older parts of the series are
  sampled every few days, so intra-period flows cannot be placed. Elsewhere the
  check says *not feasible* instead of guessing; the all-time TTWROR is only
  compared as a copy.

## What is checked

| Group | Checks |
| --- | --- |
| Inputs | activity pages complete (cursor exhausted, `totalActivities` matches), unknown types, fx rows, deposits/withdrawals; every cash-account booking mirrors a security trade (same type, time, net amount) — mirrors are then left out of every other check |
| Positions | rebuilt shares vs Parqet per holding and per ISIN; vs snapshot per ISIN and per ISIN × portfolio (`holdings[].accounts`); applied splits vs `holdings[].splits`; no sell exceeds the position (a missing split shows up here) |
| Cost basis | FIFO vs Parqet `purchaseValue` (per holding) and snapshot `cost` (per ISIN and per account); moving average vs `costAustria`; `avg = cost / shares` |
| Lots | Σ lot shares = shares, Σ lot cost = cost; snapshot lots = rebuilt FIFO lots (date, shares, cost, fee, account) |
| Valuation | shares × price = value; value vs Parqet `currentValue`; Σ holdings + `cash` = `totals.value` = Parqet valuation; cash balance rebuilt from the mirrored trades vs Parqet vs snapshot; `unrealized = value − cost − open-lot buy fees` (fees from the audit's own lot rebuild); `totalGain` = securities value + Σ received − Σ paid from raw cash flows; `totals.invested` = Σ open FIFO cost; `totals.unrealized` = Σ holding rows; Parqet's unrealized gross − net vs the remaining lots' buy fees |
| Realised | per sell vs Parqet's own row fields; per holding and total (gross, net) vs Parqet; net per ISIN vs snapshot `holdings.realized` + `closed.realizedNet` |
| Dividends | gross / net / tax / fees vs Parqet and snapshot; per ISIN; all fees & taxes; `totalGain = unrealized + realized + dividendsNet` |
| Returns | XIRR vs Parqet and snapshot; per-portfolio XIRR (if per-portfolio payloads exist); range XIRRs; TTWROR sanity; snapshot ranges = Parqet ranges |
| Series | last point = `totals.value` / `totals.invested` (Parqet's capital line adds the cash accounts' `purchaseValue`, signed by the balance); no negatives; dates strictly increasing; pointwise = Parqet chart (`bod` points excluded) |
| Ledger | row count; count and Σ gross / fee / tax / signed net per type; signs (buys −, sells / dividends +); every row matches one raw activity |
| Freshness | newest and oldest open-position quote, snapshot `convertedAt` and `asOf` |

## Tolerances

| What | Tolerance |
| --- | --- |
| shares | 1e‑6 |
| one money value vs another | €0.01 (snapshot values are rounded to cents) |
| a sum of *n* rounded values | max(€0.01, n × €0.005) |
| shares × price vs value | shares × €0.005 + €0.01 (price is rounded) |
| XIRR, range XIRR, copied TTWROR | 0.01 percentage points |
| TTWROR rebuilt from the series | 0.25 pp — **WARN** only (flows are placed per day, not per trade time) |
| quotes / snapshot age | 3 calendar days — **WARN** |

## Reading the output

```
STATUS  GROUP        CHECK                                   DETAIL
PASS    Cost basis   FIFO … vs Parqet purchaseValue          3/3 within tol, max |Δ| 0.0
FAIL    Series       Dates strictly increasing               1 violation(s) in 3 points
                     · #1 2025-03-08 after 2025-03-08
```

* `PASS` / `FAIL` — compared within tolerance or not. Failing items are listed
  under the row (up to 8; `--verbose` for all) as `label: Δ ours − theirs`.
* `WARN` — a sanity check or a known source quirk; does not change the exit code.
* `SKIP` — the input needed for the check is absent.
* Exit code: 0 all good, 1 at least one FAIL, 2 inputs missing.

## Known source quirk

Parqet's **portfolio-level unrealized net** deducts *all* lifetime buy fees of
every still-open holding — including fees of lots that were already sold, which
Parqet also deducts in realised net (via `buyAmountNet`). Those fees are counted
twice in Parqet's `totalNet`. The check *"Parqet unrealized gross−net = buy fees
of remaining lots"* reports the size of that double count as a WARN.
