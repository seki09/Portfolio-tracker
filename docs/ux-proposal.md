# UX Proposal — Portfolio Tracker

Working title: **Portfolio Tracker**. Self-hosted, single user, stocks and ETFs, imports
from broker CSV/XLSX and PDF statements.

---

## 1. Product thesis

> Turn broker exports into a trustworthy, always-current picture of what you own, what it
> is worth, and how it got there.

Three jobs the product must do well, in priority order:

1. **"What am I worth right now?"** — answered in under five seconds of opening the app,
   without clicking anything.
2. **"How did I get here?"** — value history, and the ability to separate *money I paid in*
   from *money the market made me*.
3. **"Get my data in without pain."** — importing a year of broker exports should feel
   routine and reversible, not like a one-way migration you have to get right first time.

Everything else (allocation breakdowns, dividend calendars, benchmarks) is in service of
those three and should not compete with them for screen space.

## 2. Design principles

These are the tie-breakers when two designs both look reasonable.

1. **The ledger is the truth.** Every number on every screen traces back to transactions
   you can click through to. If a figure cannot be explained by drilling down, it does not
   ship. This is the single biggest trust differentiator over a spreadsheet.
2. **Import is a conversation, not a gamble.** Nothing is written to the ledger until you
   have seen exactly what will be written. Every import is one batch, and every batch can
   be reverted in one click, forever.
3. **Never silently guess.** An unmatched security, an ambiguous row, a missing price — each
   becomes an explicit, resolvable task in a review queue. The app would rather show you a
   gap than a confident wrong number.
4. **Fast answers first, detail on demand.** The dashboard answers; the sub-pages explain.
   No screen tries to do both.
5. **Degrade honestly.** When the price feed is down or stale, values still render, marked
   with an "as of" badge. An offline price provider must never look like a zeroed portfolio.
6. **Keyboard-first for repeat use.** `⌘K` command palette, `j`/`k` row navigation, `/` to
   filter, `u` to undo the last import. You will use this app weekly for years.

## 3. Information architecture

```
┌──────────────┬──────────────────────────────────────────────────────────┐
│              │  [ All accounts ▾ ]        [ 1M 6M YTD 1Y 5Y MAX ]   ⌘K  │
│  Dashboard   ├──────────────────────────────────────────────────────────┤
│  Holdings    │                                                          │
│  Performance │                     ( page content )                     │
│  Transactions│                                                          │
│  Import    ② │                                                          │
│  ─────────── │                                                          │
│  Accounts    │                                                          │
│  Securities  │                                                          │
│  Settings    │                                                          │
└──────────────┴──────────────────────────────────────────────────────────┘
```

Persistent left nav. Two global controls in the header — **account scope** and **time
range** — apply to every page and persist across navigation, so switching pages never loses
the context you set up. A badge on **Import** counts unresolved review items.

## 4. Screens

### 4.1 Dashboard — "what am I worth right now?"

```
┌────────────────────────────────────────────────────────────────────────┐
│  Total value                                                           │
│  € 184,302.17          ▲ +€1,204.55  (+0.66%)  today                   │
│  Invested € 141,000.00 · Gain € 43,302.17 (+30.7%) · TWR +11.2% p.a.   │
│  ───────────────────────────────────────────────────────────────────── │
│                                                            ╱‾‾╲        │
│                                               ╱‾╲    ╱‾‾‾‾╯    ╲__     │
│                          ╱‾╲_____╱‾‾╲____╱‾‾‾╯   ╲__╱                  │
│         ____╱‾‾‾╲___╱‾‾‾╯                                              │
│    ╱‾‾‾╯                                                               │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ net contributions ░░░░░░░░░░░░░░░░░░  │
│  2021        2022        2023        2024        2025        2026      │
│                                       [ Value | Return % | Both ]      │
├────────────────────────────────────┬───────────────────────────────────┤
│  Allocation                        │  Movers today                     │
│  ▓▓▓▓▓▓▓▓▓▓ Equity ETF      62%    │  ASML      ▲ 3.1%   +€412         │
│  ▓▓▓▓▓▓ Single stocks       28%    │  NOVO      ▼ 2.4%   −€188         │
│  ▓▓▓ Bond ETF                7%    │  VWCE      ▲ 0.4%   +€301         │
│  ▓ Cash                      3%    │                                   │
│  [ by class | sector | region ]    │  Next dividend: VWCE, 12 Oct, ~€94 │
└────────────────────────────────────┴───────────────────────────────────┘
```

Behaviours worth specifying:

- The **shaded band under the value line is net contributions** (deposits minus
  withdrawals, cumulative). The gap between the line and the band *is* your investment
  gain, visible at a glance. This one chart answers job #2 and is the reason to make it the
  hero element rather than a bare value line.
- The headline number is "as of" the latest price we hold. If any position's price is older
  than one trading day, a subtle `as of 19 Sep` chip appears next to the total — never a
  modal, never a blocked render.
- Every tile is a link to its explaining page. Clicking "Gain €43,302.17" lands on
  Performance with the same date range applied.
- **Empty state:** the whole dashboard is replaced by a single centred card — "Import your
  first broker export" with a drop zone, plus "or add a transaction manually". No skeleton
  charts of fake data.

### 4.2 Holdings — the position table

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  Holdings · 14 positions            [ ⌕ filter ]   [ group: none ▾ ] [ ⚙ cols ] │
├──────────────┬──────┬──────────┬──────────┬─────────┬──────────┬───────────────┤
│  Name        │ Qty  │ Avg cost │  Price   │  Value  │  Gain    │  Weight       │
├──────────────┼──────┼──────────┼──────────┼─────────┼──────────┼───────────────┤
│ ▸ VWCE       │ 412  │  €102.40 │ €128.90  │ €53,107 │ ▲+25.9%  │ ▓▓▓▓▓▓▓ 28.8% │
│   Vanguard…  │      │          │  ∿∿∿╱    │         │ +€10,918 │               │
│ ▸ ASML       │  38  │  €610.22 │ €702.10  │ €26,680 │ ▲+15.1%  │ ▓▓▓ 14.5%     │
│ ▸ NOVO B     │ 210  │  kr812.0 │ kr744.5  │ €20,955 │ ▼ −8.3%  │ ▓▓ 11.4%      │
└──────────────┴──────┴──────────┴──────────┴─────────┴──────────┴───────────────┘
```

- **Expandable rows.** The `▸` opens the position inline to show the lots that make it up
  (each buy, its date, quantity, cost basis and its own unrealised gain). This is where the
  "ledger is the truth" principle earns its keep — no navigation needed to see why average
  cost is what it is.
- **Foreign-currency positions show the native price** (`kr744.5`) and the converted value.
  A tooltip gives the FX rate used and its date. Currency conversion is the most common
  source of "this number looks wrong to me", so it is always inspectable.
- **Grouping** by account, asset class, sector or region re-renders the same table with
  subtotal rows, rather than sending you to a different screen.
- **Column set is configurable** and saved: day change, dividend yield, yield on cost,
  realised gain, XIRR per position, weight, target weight drift.
- Sparklines are inline and unlabelled — they convey shape, not values.

### 4.3 Position detail

One page per security, reachable from the table or `⌘K`.

- Header: name, ISIN, ticker, exchange, current price with day change.
- Price chart with **your transactions plotted as markers on it** — buys below the line,
  sells above, dividends as small dots on the axis. Seeing your own entries against the
  price history is the feature people actually want from a position page.
- Stats: quantity, average cost, market value, unrealised gain, realised gain to date,
  total dividends received, yield on cost, XIRR for this position.
- Lots table (FIFO order) with per-lot unrealised gain.
- Transaction list filtered to this security.
- Notes field — free text, because there is always a reason you bought something.

### 4.4 Transactions — the ledger

A dense, sortable, filterable table of every event: buy, sell, dividend, fee, tax,
deposit, withdrawal, split, transfer.

- Filter chips for type, account, security, date range, and **import batch**.
- Inline edit for corrections; every edit is versioned and the row shows an "edited" marker
  with the original values on hover. Corrections happen constantly with imported data, so
  they must be cheap and auditable rather than destructive.
- Bulk select → delete, re-assign account, re-assign security.
- **Add transaction** opens a compact form that adapts to type: choosing *Dividend* shows
  gross, withholding tax and net, and computes the third field from the other two.
- Export current view to CSV — the app must never feel like a data roach motel.

### 4.5 Import — the flow that makes or breaks the product

Five steps, with a persistent stepper. Nothing touches the ledger before step 5.

```
  ①  Drop        ②  Detect       ③  Map         ④  Review       ⑤  Commit
  files          source          columns        staged rows     & undo
```

**① Drop.** Full-page drop zone accepting multiple CSV, XLSX and PDF files at once. Files
are hashed on arrival; re-dropping a file you have already imported is caught here with
"You imported this exact file on 3 Aug — import anyway?".

Files upload **directly to storage**, not through the app server, so a 30 MB multi-year
export behaves no differently from a 20 KB one. Each file shows its own progress bar and
can be removed mid-upload without abandoning the others.

**② Detect.** Each file is fingerprinted against the adapter registry (header signature for
tabular files, text markers for PDFs). Parsing runs in the background rather than blocking
the page, so this step has a visible waiting state — per file, `Parsing… 340 / 1,204 rows`
— and a large file never looks frozen. You can navigate away and come back; the batch is
waiting under Import → History in whatever state it reached. The UI reports what it found
and lets you override:

```
┌──────────────────────────────────────────────────────────────────┐
│  3 files                                                         │
│  ✓ transactions_2025.csv   Trade Republic  · 142 rows  [change ▾]│
│  ✓ depot_q3.pdf            Scalable Capital ·  18 rows [change ▾]│
│  ? export(4).xlsx          Unrecognised — map columns manually → │
└──────────────────────────────────────────────────────────────────┘
```

**③ Map** (only for unrecognised files). A two-pane mapper: the raw file preview on the
left, target fields on the right, with drag-or-select assignment. Date format, decimal
separator and thousands separator are pickers that live-update the preview so you can see
`1.234,56 → 1234.56` confirm itself. Saving the mapping creates a named **import profile**,
so the same broker's file is recognised automatically next time. This turns a one-off chore
into a permanent capability, which is what makes "import from various sources" real.

**④ Review** — the most important screen in the product.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  160 rows   ● 138 new   ◐ 14 duplicates   ▲ 8 need attention              │
│  [ all ] [ new ] [ duplicates ] [ needs attention ]        Account: TR ▾   │
├───┬────────────┬────────┬──────────────┬───────┬───────────┬──────────────┤
│ ✓ │ 2025-03-04 │ BUY    │ VWCE         │  12   │  €1,510.80│ ● new        │
│ ✓ │ 2025-03-31 │ DIV    │ ASML         │       │    €102.40│ ● new        │
│ ▲ │ 2025-04-02 │ BUY    │ ??? US0378…  │   5   │  €880.00  │ unknown ISIN │
│   │            │        │ └ [ search & link ] [ create manually ]         │
│ ◐ │ 2025-04-09 │ SELL   │ NOVO B       │  20   │  €1,392.10│ already exists│
└───┴────────────┴────────┴──────────────┴───────┴───────────┴──────────────┘
```

- Rows are **inline editable** — fix a date, correct a fee, change the type, without
  leaving the screen or re-exporting from the broker.
- Duplicates are detected by a content hash plus the broker's own reference where present,
  and are **unchecked by default but visible**. Hiding them would be the easy choice and
  the wrong one: the common real-world case is overlapping date ranges between exports, and
  you need to see that the overlap was handled.
- "Needs attention" rows block commit only for themselves; you can commit the clean 138 and
  come back to the 8. Partial progress beats an all-or-nothing wall.
- Unknown securities resolve via a search-and-link panel (by ISIN, ticker or name) or a
  "create manually" escape hatch for anything the price provider does not know.

**⑤ Commit & undo.** Committing writes all checked rows under one batch id and lands you on
a summary: *"142 transactions imported from Trade Republic · 4 new securities · [Undo this
import]"*. The batch remains listed under Import → History with a revert button for as long
as it exists. Knowing you can always back out is what makes people willing to import at all.

### 4.6 Review queue

A standing list of everything the app refused to guess about: unmatched securities, missing
prices for a date we need, transactions that would make a position go negative, FX rates we
could not fetch. Each item states the consequence ("VWCE value is stale since 19 Sep") and
offers a fix. This is the pressure valve that lets principle #3 hold without nagging modals.

### 4.7 Accounts and Securities

- **Accounts:** one row per broker account — name, broker, currency, current value, share
  of portfolio, transaction count, last import. Archive rather than delete, so history
  survives closing an account.
- **Securities:** the instrument master. Name, ISIN, WKN, ticker, type, currency, and the
  **price source and symbol used**, editable. When an automatic ISIN→symbol mapping picks
  the wrong listing (a real and frequent problem for European ETFs with many listings), this
  is where you correct it, with a "test fetch" button to confirm before saving.

### 4.8 Settings

Base currency · cost-basis method (FIFO default) · price provider and API key · fetch
schedule · theme · **backup and restore** (download a full JSON/CSV export, restore from
one) · danger zone (wipe all data). Backup is a first-class, visible feature, not a CLI
afterthought — it is the reassurance that makes self-hosting acceptable.

## 5. Cross-cutting interactions

**Time range.** `1M · 6M · YTD · 1Y · 5Y · MAX · custom`, global and persistent. Every
percentage on screen is for the selected range, and the range is restated in the metric
label ("Return, YTD") so a screenshot is never ambiguous.

**TWR vs money-weighted return.** Both matter and they answer different questions, so the
app shows both with plain-language labels rather than acronyms:

- *"How did my investments perform?"* — time-weighted return, contribution-neutral, the
  number to compare against an index.
- *"What did I actually earn?"* — money-weighted (XIRR), which accounts for when you put
  money in.

An info popover explains the difference in two sentences with the user's own numbers. Most
trackers dump "TWR / IRR" on you and leave you to it; explaining it in context is cheap and
is the kind of thing that makes a personal tool feel considered.

**Stale and missing data.** Three states, all non-blocking: fresh (no marker), stale (`as
of <date>` chip), unavailable (value rendered from last known price, struck-through price,
link to the review queue).

**Undo.** Import batches revert. Transaction edits and deletes are soft and restorable for
30 days from Settings → Trash.

## 6. Onboarding

Four steps on first run, all skippable, none blocking:

1. Base currency.
2. Create your first account (name + broker + currency).
3. Import a file, or add a transaction manually, or **load demo data** to explore the app
   before committing real data to it.
4. Optional: price provider API key, with a "test connection" button.

Demo data is worth building. It makes the app explorable, and it doubles as the fixture set
for screenshots and tests.

## 7. Visual language

- **Density over decoration.** This is a data tool. Compact tables, tabular-figure numerals
  so digits align in columns, generous use of the full window width.
- **Typography:** one UI sans-serif; all monetary and quantity values in tabular figures.
  Value magnitude is conveyed by weight and size, never by colour alone.
- **Colour carries meaning, and only meaning.** Chrome is neutral greys. Gain/loss colour is
  reserved exclusively for gain/loss. Charts use one accent for portfolio value and a muted
  neutral for contributions; categorical allocation colours come from a fixed ordered
  palette so a given asset class keeps its colour across every chart in the app.
- **Charts:** area for value history with a contributions band; donut *or* bar for
  allocation (bar past ~6 categories, where a donut stops being readable); calendar-style
  bars for monthly dividend income; unlabelled sparklines in tables. No 3D, no gradients
  that imply data, no dual y-axes.
- **Dark mode from day one**, as a genuine second theme with its own chart colours — not an
  inverted filter. A portfolio gets checked at night.

## 8. Responsive behaviour

Desktop-first, because the import and review flows are inherently table work. But
*checking* the portfolio is a phone activity, so below 768px:

- Nav collapses to a bottom bar: Dashboard · Holdings · Transactions · More.
- Dashboard becomes a single column: total, chart, allocation, movers.
- Holdings becomes cards (name, value, gain) rather than a horizontally scrolling table.
- Import is available but honest about it — "this works best on a larger screen" — with the
  drop step supported so you can queue a file from your phone and review it later.

## 9. Accessibility

- Gain/loss is never colour-only: always a sign or an arrow glyph alongside.
- All chart data is available as a table (a "view as table" toggle per chart), which also
  serves copy-paste users.
- Full keyboard reachability, visible focus rings, correct table semantics for screen
  readers, respects `prefers-reduced-motion` and `prefers-color-scheme`.
- Contrast targets WCAG AA, checked in both themes, including chart series against their
  backgrounds.

## 10. Explicit non-goals for v1

Naming these protects the schedule; each is a plausible v2.

- Crypto, cash accounts, bonds-by-maturity, options, real estate, manual/illiquid assets.
  (The data model accommodates them; the UI does not.)
- Multi-user accounts, sharing, or any public/read-only view. (*Hosting* the app in the
  cloud is a separate question and is planned for — see
  [deployment-portability.md](deployment-portability.md). It remains a single-user app
  either way: one deployment, one password, one portfolio.)
- Tax reporting or tax-lot optimisation. German specifics (Vorabpauschale, Teilfreistellung)
  are out of scope and should not be half-implemented.
- Trading, rebalancing execution, or broker write access.
- Real-time streaming prices. End-of-day, with an on-demand refresh, is the v1 contract.
- Mobile app. The responsive web view is the mobile story.

## 11. Open questions

1. ~~**Which brokers first?**~~ **Answered:** Parqet (migration), flatex.at and DADAT /
   dad.at. See [implementation-plan.md §4.1](implementation-plan.md) — Parqet goes first
   because its export seeds the whole history in one import.
2. **Base currency** — EUR assumed throughout, consistent with all three sources.
3. **Cost basis method** — FIFO assumed. Average cost is the alternative and changes both
   the lots UI and the realised-gain figures.
4. **Benchmark comparison** — worth it for v1, or v2? It is cheap once the daily series
   exists (one extra security's price history) and it is the first thing people ask for
   after seeing a return number.
5. **Is the Parqet export complete for your earliest years?** The plan assumes it is, and
   demotes PDF parsing below analytics on that basis. If Parqet is missing your first
   year or two, say so — the flatex/DADAT PDF adapters move back up the list.
