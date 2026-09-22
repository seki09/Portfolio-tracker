# Implementation Plan — Portfolio Tracker

Companion to [ux-proposal.md](ux-proposal.md). Scope: self-hosted single-user web app,
stocks and ETFs, CSV/XLSX and PDF imports, TypeScript end to end.

---

## 1. Architecture

```
                    ┌─────────────────────────────────────────┐
  browser ────────► │  Next.js (App Router)                   │
                    │   • React Server Components for reads   │
                    │   • Server Actions / route handlers     │
                    │   • Upload handling → object store      │
                    └───────────────┬─────────────────────────┘
                                    │ imports (in-process)
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐         ┌──────────────────┐        ┌──────────────────┐
│ packages/core │         │ packages/import  │        │ packages/prices  │
│  ledger, lots │         │  adapters, CSV,  │        │  provider adapters│
│  valuation,   │         │  XLSX, PDF,      │        │  EOD + FX, cache │
│  TWR / XIRR   │         │  dedupe, staging │        │                  │
│  (pure, no IO)│         └──────────────────┘        └────────┬─────────┘
└───────┬───────┘                  │                           │
        └──────────────┬───────────┘                    external HTTP
                       ▼                                       │
             ┌────────────────────┐                            │
             │ packages/db        │◄───────────────────────────┘
             │  Drizzle schema    │
             └─────────┬──────────┘
                       ▼
             ┌────────────────────┐        ┌──────────────────────────┐
             │ PostgreSQL 16      │        │ worker (node-cron)       │
             │  ledger + caches   │◄───────│  nightly EOD prices, FX, │
             └────────────────────┘        │  series materialisation  │
                                           └──────────────────────────┘
```

Three containers in `docker compose`: `web`, `worker`, `db`. Uploaded files live on a
mounted volume, not in the database — they are re-parseable evidence, and keeping them out
of Postgres keeps backups small and `pg_dump` fast.

### Why this shape

- **A pure-functional core.** `packages/core` has no database, no network and no clock
  passed implicitly. Every financial calculation is a function from ledger + prices to a
  result. This is the part that must be *right*, and purity is what makes it exhaustively
  testable — the difference between trusting your net worth number and hoping.
- **Recompute rather than maintain incremental state.** Positions, lots and realised gains
  are derived from the transaction list on demand and cached, never stored as
  authoritative mutable state. For a personal portfolio (< ~50k transactions over decades)
  a full recompute is milliseconds. Incremental lot maintenance is where portfolio trackers
  accumulate their worst bugs — an edited 2019 transaction silently failing to propagate —
  and there is no performance reason to accept that risk here.
- **Importers as a registry of adapters** behind one interface, so adding a broker is a new
  file plus fixtures, never a change to the pipeline.
- **A separate worker** so a slow price provider can never block a page render, and so the
  nightly fetch runs whether or not a browser is open.

### Stack

| Layer | Choice | Rationale |
| --- | --- | --- |
| Framework | Next.js 15 (App Router), TypeScript strict | One deployable for UI and API; Server Components keep heavy table data off the wire |
| DB | PostgreSQL 16 | `numeric` exact arithmetic, date-range queries, window functions for the daily series; SQLite would work but `numeric` and timezone handling are safer here |
| ORM | Drizzle | Typed SQL that stays SQL, plain migration files — the valuation queries want real SQL, not an abstraction fighting them |
| Money | `decimal.js` + Postgres `numeric` | **No floats anywhere in the money path.** Non-negotiable |
| UI | Tailwind + shadcn/ui (Radix) | Accessible primitives, dense data tables, fast to build |
| Tables | TanStack Table | Virtualised, sortable, groupable, column visibility |
| Charts | Recharts, or uPlot if the daily series gets slow | Enough for area/bar/donut; uPlot is the escape hatch for 10k+ point series |
| Parsing | `papaparse` (CSV), `exceljs` (XLSX), `pdfjs-dist` (PDF text) | All pure-JS, no native deps, no system binaries |
| Jobs | `node-cron` in the worker | Right-sized; a queue (BullMQ) is unnecessary for a handful of daily jobs |
| Tests | Vitest + Playwright | Unit/property for core, golden-file for adapters, E2E for the import flow |

### Repository layout

```
apps/web/                 Next.js app — routes, components, server actions
packages/core/            domain logic (pure): ledger, lots, valuation, returns
packages/db/              Drizzle schema, migrations, seed + demo data
packages/importers/       adapter registry, csv/, xlsx/, pdf/, fixtures/
packages/prices/          price + FX provider abstraction and adapters
packages/shared/          types, Decimal helpers, date utils, currency formatting
docker/                   Dockerfile(s), compose, backup script
docs/                     these documents
```

A pnpm workspace monorepo. Worth the small setup cost: it is what keeps `core` honest about
having no IO, since it simply cannot import the database package.

## 2. Data model

Exact types matter more than shape here. Quantities carry 10 decimal places (fractional
shares from savings plans), money 4 (sub-cent fees and FX-converted amounts).

```sql
-- Instrument master ------------------------------------------------------
CREATE TABLE security (
  id            uuid PRIMARY KEY,
  isin          text UNIQUE,
  wkn           text,
  ticker        text,
  name          text NOT NULL,
  type          text NOT NULL,            -- STOCK | ETF | FUND | OTHER
  currency      char(3) NOT NULL,
  exchange      text,
  sector        text,
  country       text,
  price_source  text,                     -- provider id, user-overridable
  price_symbol  text,                     -- symbol at that provider
  is_manual     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Broker accounts --------------------------------------------------------
CREATE TABLE account (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  broker     text,
  type       text NOT NULL,               -- DEPOT | CASH
  currency   char(3) NOT NULL,
  archived_at timestamptz,
  sort_order int NOT NULL DEFAULT 0
);

-- The ledger. Append-mostly; edits are versioned, deletes are soft. -------
CREATE TABLE transaction (
  id             uuid PRIMARY KEY,
  account_id     uuid NOT NULL REFERENCES account(id),
  security_id    uuid REFERENCES security(id),   -- null for cash-only events
  type           text NOT NULL,   -- BUY SELL DIVIDEND FEE TAX INTEREST
                                  -- DEPOSIT WITHDRAWAL SPLIT TRANSFER_IN TRANSFER_OUT
  executed_at    timestamptz NOT NULL,
  quantity       numeric(28,10),
  price          numeric(28,10),          -- per unit, in `currency`
  gross_amount   numeric(28,4),
  fee            numeric(28,4) NOT NULL DEFAULT 0,
  tax            numeric(28,4) NOT NULL DEFAULT 0,
  net_amount     numeric(28,4) NOT NULL,  -- signed cash effect on the account
  currency       char(3) NOT NULL,
  fx_rate        numeric(20,10),          -- currency -> base, at execution
  note           text,
  import_batch_id uuid REFERENCES import_batch(id),
  external_ref   text,                    -- broker's own reference, if any
  dedupe_hash    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE UNIQUE INDEX ON transaction (account_id, dedupe_hash) WHERE deleted_at IS NULL;
CREATE INDEX ON transaction (security_id, executed_at);
CREATE INDEX ON transaction (executed_at);

CREATE TABLE transaction_revision (          -- audit trail for inline edits
  id uuid PRIMARY KEY, transaction_id uuid NOT NULL, snapshot jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- Market data ------------------------------------------------------------
CREATE TABLE price (
  security_id uuid NOT NULL REFERENCES security(id),
  on_date     date NOT NULL,
  close       numeric(28,10) NOT NULL,
  currency    char(3) NOT NULL,
  source      text NOT NULL,
  PRIMARY KEY (security_id, on_date)
);
CREATE TABLE fx_rate (
  base char(3), quote char(3), on_date date, rate numeric(20,10) NOT NULL,
  source text NOT NULL, PRIMARY KEY (base, quote, on_date)
);
CREATE TABLE corporate_action (
  id uuid PRIMARY KEY, security_id uuid NOT NULL, type text NOT NULL, -- SPLIT
  ex_date date NOT NULL, ratio_num numeric, ratio_den numeric, source text
);

-- Import pipeline --------------------------------------------------------
CREATE TABLE import_batch (
  id uuid PRIMARY KEY, filename text NOT NULL, file_sha256 text NOT NULL,
  stored_path text, adapter_id text NOT NULL, account_id uuid REFERENCES account(id),
  status text NOT NULL,            -- STAGED | COMMITTED | REVERTED
  stats jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), reverted_at timestamptz
);
CREATE TABLE staged_transaction (
  id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  row_no int NOT NULL, raw jsonb NOT NULL, parsed jsonb NOT NULL,
  status text NOT NULL,            -- NEW | DUPLICATE | NEEDS_ATTENTION | EXCLUDED
  issues jsonb NOT NULL DEFAULT '[]', resolved_security_id uuid REFERENCES security(id)
);
CREATE TABLE import_profile (      -- a saved column mapping = a new "source"
  id uuid PRIMARY KEY, name text NOT NULL, adapter_id text NOT NULL,
  column_map jsonb NOT NULL, options jsonb NOT NULL,  -- date fmt, separators, tz
  signature text                    -- header fingerprint for auto-detection
);

-- Derived cache (rebuildable; never authoritative) ------------------------
CREATE TABLE portfolio_value_daily (
  account_id uuid NOT NULL, on_date date NOT NULL,
  market_value numeric(28,4) NOT NULL, cost_basis numeric(28,4) NOT NULL,
  cash numeric(28,4) NOT NULL, net_contributions numeric(28,4) NOT NULL,
  PRIMARY KEY (account_id, on_date)
);
CREATE TABLE setting (key text PRIMARY KEY, value jsonb NOT NULL);
```

Notes on the decisions that are easy to get wrong:

- **`net_amount` is the signed cash effect** and is what cash balances and contribution
  math sum. Storing it explicitly rather than deriving it from gross/fee/tax means an
  import that only gives you a net figure is representable without inventing components.
- **`dedupe_hash`** = `sha256(account_id, date, type, isin, quantity, net_amount)`, with
  `external_ref` preferred when the broker provides one. The partial unique index makes the
  database the final guard against double imports even if the staging logic has a bug.
- **Soft deletes plus revisions.** Imported data gets corrected constantly; an audit trail
  is what lets you trust a number you edited eighteen months ago.
- **`portfolio_value_daily` is a cache with a watermark.** Any ledger write sets a rebuild
  watermark to the earliest affected date; the worker rebuilds forward from there. It can
  be dropped and regenerated at any time without data loss.
- Crypto, cash and manual assets need no schema change — only new `security.type` values
  and UI. That is the point of keeping v1's scope narrow without painting into a corner.

## 3. Core engines (`packages/core`)

```ts
// Ledger → positions. Pure, deterministic, no IO.
export function buildLots(
  txs: Transaction[],
  opts: { method: "FIFO" | "AVERAGE"; splits: CorporateAction[] }
): { lots: Lot[]; realised: RealisedGain[]; positions: Position[] };

// Positions + market data → money.
export function valueOn(
  date: DateOnly, positions: Position[], prices: PriceLookup, fx: FxLookup,
  base: Currency
): Valuation;

// The series behind the dashboard chart.
export function dailySeries(
  range: { from: DateOnly; to: DateOnly },
  txs: Transaction[], prices: PriceLookup, fx: FxLookup, base: Currency
): DailyPoint[];   // { date, marketValue, costBasis, cash, netContributions }

// Returns.
export function timeWeightedReturn(points: DailyPoint[], flows: CashFlow[]): number;
export function moneyWeightedReturn(flows: CashFlow[], finalValue: Money): number; // XIRR
```

**Lot tracking.** FIFO by default. A sale consumes lots oldest-first, producing
`RealisedGain` records that carry the matched buy date — needed for holding-period display
and, later, for tax work. Splits rewrite quantities and per-unit costs of all lots with an
acquisition date before the ex-date. Transfers between accounts move lots and preserve
their original cost basis and acquisition date rather than creating a synthetic buy, which
is the behaviour that keeps realised-gain figures correct after a broker migration.

**Daily series.** For each date in range: carry positions forward from the ledger, look up
each security's price with **last-observation-carried-forward** (weekends, holidays and
provider gaps must not produce a zero-value day — the single most common visual bug in
homemade trackers), convert via that day's FX with the same carry-forward rule, and sum.
Computed in SQL for the bulk case (a generated date series joined against prices) and in TS
for ad-hoc ranges; both paths are tested against each other.

**Returns.** TWR is computed by chaining daily sub-period returns with external cash flows
removed, so contributions do not register as performance. XIRR uses Newton–Raphson with a
bisection fallback, because Newton alone diverges on the irregular flow patterns that
savings plans produce. Both are tested against hand-computed fixtures and against known
spreadsheet results.

## 4. Import framework (`packages/importers`)

```ts
export interface ImportAdapter {
  id: string;                       // "trade-republic-csv"
  label: string;                    // "Trade Republic — transaction export"
  kind: "csv" | "xlsx" | "pdf";
  /** 0..1 confidence this adapter understands the file. Registry picks the max. */
  detect(probe: FileProbe): Promise<number>;
  parse(file: FileInput, ctx: ParseContext): Promise<ParseResult>;
}

export interface ParsedRow {
  rowNo: number;
  raw: Record<string, string>;      // kept verbatim, shown in the review table
  tx: Partial<CanonicalTransaction>;
  issues: RowIssue[];               // UNKNOWN_SECURITY | AMBIGUOUS_TYPE | BAD_DATE | ...
}
```

The pipeline is a chain of pure stages, each independently testable:

```
detect → parse → normalise → resolveSecurities → dedupe → stage → (user review) → commit
```

- **normalise**: dates to UTC instants using the file's stated or configured timezone,
  numbers via the profile's separators, signs to the canonical convention (money out is
  negative), broker type strings to canonical enum values.
- **resolveSecurities**: ISIN first (exact), then ticker + currency, then fuzzy name match
  against existing securities, then the price provider's search. Anything below a
  confidence threshold becomes an `UNKNOWN_SECURITY` issue rather than a guess.
- **dedupe**: against both committed transactions and other rows in the same batch.
- **commit**: one transaction, all rows under one `import_batch_id`, then the daily-series
  watermark is moved back to the earliest imported date.

**Generic CSV/XLSX adapter.** The fallback that makes "various sources" true: a
column-mapping UI whose output saves as an `import_profile` with a header signature, so the
next file from that broker is auto-detected. Every broker-specific adapter is really just a
pre-baked profile plus quirk handling.

**PDF adapters.** `pdfjs-dist` extracts positioned text; adapters match against
layout-aware patterns (anchor labels plus column x-ranges) rather than brittle whole-page
regexes. PDF layouts change without notice, so: pin a fixture per broker per layout
version, detect the version explicitly, and fail *loudly into the review queue* rather than
parsing a changed layout into plausible-looking wrong numbers. Scanned/image PDFs are out
of scope — detect the absence of a text layer and say so.

**Planned adapter set** (final list pending question 1 in the UX doc): generic CSV/XLSX,
Trade Republic (CSV + PDF), Scalable Capital (CSV + PDF), IBKR Activity Statement (CSV),
DEGIRO (CSV).

## 5. Price and FX data (`packages/prices`)

```ts
export interface PriceProvider {
  id: string;
  search(query: string): Promise<SecurityMatch[]>;
  eod(symbol: string, from: DateOnly, to: DateOnly): Promise<PricePoint[]>;
  latest(symbols: string[]): Promise<PricePoint[]>;
}
```

Everything sits behind this interface with the provider configurable in Settings, because
free market-data sources change terms, rate limits and availability with no warning — a
hard dependency on one is the most likely cause of this app breaking a year from now.

- **Candidates:** Yahoo Finance (unofficial, broad ISIN/European-listing coverage, no key,
  but no usage guarantee), stooq (free EOD CSV), Alpha Vantage / Twelve Data / Finnhub
  (keyed free tiers with low rate limits), EOD Historical Data (paid, reliable). Default to
  one, document the trade-off in Settings, and make switching a dropdown.
- **ISIN → symbol** is the genuinely hard part for European ETFs, where one ISIN has many
  listings in different currencies. Resolution runs through OpenFIGI where available, and
  the resolved symbol is stored on `security` and **editable with a "test fetch" button** —
  a manual override is not a fallback here, it is a required feature.
- **FX:** ECB daily reference rates (free, authoritative, no key) with carry-forward.
- Everything is cached in `price`/`fx_rate` and fetched once. Rate limiting and retry with
  backoff live in the provider wrapper, not in callers.
- **Manual price entry** exists for any security no provider knows, which is also what makes
  the model extensible to illiquid assets later.

## 6. Background jobs (worker)

| Job | Schedule | Work |
| --- | --- | --- |
| EOD price fetch | daily, after market close | Latest close for every held security |
| FX refresh | daily | ECB rates for all currency pairs in use |
| Backfill | on demand | Full history for a newly added security, back to its first transaction |
| Series rebuild | after any ledger write, and nightly | Rebuild `portfolio_value_daily` forward from the watermark |
| Backup | daily (optional) | `pg_dump` + uploaded files → a configured directory, with rotation |

All jobs are idempotent and safe to re-run; each writes a run record surfaced in Settings →
System, so "why is my data stale" is answerable from inside the app.

## 7. Testing strategy

Correctness here is the product, so the test pyramid is deliberately bottom-heavy.

- **Golden-file adapter tests.** Every adapter gets `fixtures/<adapter>/<case>.csv|pdf` and
  a checked-in `.expected.json`. Fixtures are **redacted** (account numbers, names) but
  otherwise byte-real. This is the only way to safely accept a broker changing its format:
  add a fixture, watch it fail, fix the adapter.
- **Property tests** (fast-check) for lot maths: quantity is conserved; the sum of realised
  and unrealised gain equals total gain; a buy-then-sell of everything leaves no lots; FIFO
  consumption is order-independent for same-day lots; no operation produces a negative
  position without an explicit issue.
- **Known-answer tests** for XIRR and TWR against spreadsheet-verified fixtures, including
  the nasty cases: a full withdrawal mid-period, a same-day buy and sell, a portfolio that
  goes to zero and is refunded.
- **Timezone and DST fixtures**, because a trade executed at 23:30 CET must not land on the
  wrong day and silently shift a whole history chart.
- **Playwright E2E** for the one flow that must never break: drop file → detect → review →
  commit → holdings reflect it → undo → holdings revert.
- **CI** (GitHub Actions): typecheck, lint, unit, migration-up-down check, Docker build.

## 8. Security and operations

Single-user and self-hosted simplifies this, but does not eliminate it.

- **Auth:** a password set via environment variable, argon2-hashed, with an HTTP-only
  session cookie. Simple, and enough — as long as the deployment docs are blunt that this
  belongs behind a VPN or a reverse proxy with TLS, not on the open internet.
- **Secrets:** provider API keys in environment variables, never in the database, never in
  the client bundle. All provider calls are server-side.
- **Uploads:** size and MIME allow-list, stored outside the web root, parsed in-process with
  no shell-outs and no network access from parsers.
- **No telemetry, no outbound calls except the configured price/FX provider.** That is the
  whole point of self-hosting, and it should be stated in the README.
- **Backup and restore is a shipped feature**, not a documented `pg_dump` incantation.

## 9. Milestones

Estimates assume one developer working part-time. Each milestone ends in something usable —
no milestone is purely internal.

| # | Milestone | Deliverable | Est. |
| --- | --- | --- | --- |
| **M0** | Foundations | pnpm monorepo, Docker compose, Postgres, Drizzle migrations, CI, auth, app shell with nav | ~1 wk |
| **M1** | Ledger core | Schema, `buildLots`, manual transaction entry, accounts, securities CRUD, holdings table with cost basis — **usable as a manual tracker** | ~2 wks |
| **M2** | Prices & history | Provider abstraction + first provider, EOD/FX fetch, `dailySeries`, `portfolio_value_daily`, dashboard with the value + contributions chart | ~1.5 wks |
| **M3** | Import pipeline | Adapter registry, generic CSV/XLSX adapter, column mapper, import profiles, staging, dedupe, review screen, commit + undo, **2 broker adapters** | ~2.5 wks |
| **M4** | PDF import | `pdfjs-dist` extraction, layout-aware matching, 2 broker PDF adapters, version detection, fixture harness | ~1.5 wks |
| **M5** | Analytics | TWR + XIRR, position detail page with transaction markers, allocation breakdowns, dividend history and calendar, realised gains | ~1.5 wks |
| **M6** | Polish | Review queue, backup/restore, demo data, responsive layouts, dark mode, keyboard shortcuts, accessibility pass, benchmark comparison | ~1.5 wks |

**Critical path: M1 → M2 → M3.** After M2 the app is genuinely useful with manually entered
data, which is the right point to start using it daily and let real use reorder M4–M6.

Sequencing note: M3 before M4 deliberately. The staging, dedupe, review and undo machinery
is shared by both, and it is much easier to build and debug against CSV — where you can see
the input — than against PDF text extraction.

## 10. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Free price provider disappears or changes terms | Portfolio stops valuing | Provider abstraction from day one; two implementations by M2; manual price entry always available |
| ISIN → listing resolution picks the wrong exchange | Wrong values, subtly | Editable `price_symbol` with a test-fetch button; flag currency mismatch between security and returned price |
| Broker changes its export format | Adapter silently mis-parses | Version detection + golden fixtures; adapters fail into the review queue rather than guessing |
| PDF extraction proves brittle across layout versions | M4 overruns | Time-box per adapter; CSV path always available as the fallback; detect unknown layout and say so explicitly |
| Float arithmetic leaks into the money path | Cent-level drift, eroded trust | `numeric` + `decimal.js`, a lint rule banning arithmetic operators on money types, property tests asserting exact sums |
| Corporate actions (splits, mergers) handled wrongly | Historical quantities wrong | Manual corporate-action entry in v1 with a clear UI; automatic feeds only once a provider proves reliable |
| Scope creep into crypto/cash/tax | Nothing ships | Non-goals are explicit in the UX doc; schema is ready so deferring costs nothing later |

## 11. Immediate next steps

1. Answer the five open questions at the end of the UX proposal — brokers, base currency,
   cost-basis method, benchmark, and the shape of your historical data.
2. Approve or amend this plan; the sequencing in §9 is the part most worth arguing with.
3. Start M0: scaffold the monorepo, compose file and CI.
4. In parallel, collect **one real export file per broker** you hold. Those files are the
   specification for M3 and M4, and redacted copies become the first fixtures.
