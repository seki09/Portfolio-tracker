# Portfolio Tracker

A private, self-hosted portfolio tracker. Import broker exports (CSV/XLSX and PDF
statements), keep an immutable transaction ledger, and get a trustworthy picture of
what you hold today and how the portfolio got there.

**Status:** design phase. No code yet — start with the two documents below.

| Document | What it covers |
| --- | --- |
| [docs/ux-proposal.md](docs/ux-proposal.md) | Product thesis, design principles, information architecture, screen-by-screen wireframes, the import flow, visual language, accessibility, non-goals |
| [docs/implementation-plan.md](docs/implementation-plan.md) | Architecture, stack rationale, data model, ledger/valuation engines, importer framework, price data, jobs, testing, milestones, risks |
| [docs/deployment-portability.md](docs/deployment-portability.md) | Running the same codebase locally *and* on a serverless host (Netlify + managed Postgres) — the five seams, the rules that keep them intact, and the privacy trade-off |
| [prototype/index.html](prototype/index.html) | Clickable prototype — dashboard, holdings with lot drill-down, ledger, and the full five-step import flow. Open the file in a browser; no build step |

## Scope decided for v1

- **Deployment:** local-first / self-hosted, single user, `docker compose up` — built
  against platform-neutral seams so a serverless deploy (Netlify + Neon) is a config change,
  not a rewrite
- **Asset classes:** stocks and ETFs (schema stays extensible to crypto, cash and manual assets)
- **Imports:** Parqet (migration), flatex.at and DADAT CSV/XLSX, then broker PDF statements —
  see [implementation-plan.md §4.1](docs/implementation-plan.md)
- **Stack:** TypeScript end to end — Next.js, PostgreSQL, Drizzle

## Open decisions

Listed at the end of each document. The ones that block the most work are which brokers
to support first, base currency, and cost-basis method.
