# Portfolio Tracker

A private, self-hosted portfolio tracker. Import broker exports (CSV/XLSX and PDF
statements), keep an immutable transaction ledger, and get a trustworthy picture of
what you hold today and how the portfolio got there.

**Status:** design phase. No code yet — start with the two documents below.

| Document | What it covers |
| --- | --- |
| [docs/ux-proposal.md](docs/ux-proposal.md) | Product thesis, design principles, information architecture, screen-by-screen wireframes, the import flow, visual language, accessibility, non-goals |
| [docs/implementation-plan.md](docs/implementation-plan.md) | Architecture, stack rationale, data model, ledger/valuation engines, importer framework, price data, jobs, testing, milestones, risks |

## Scope decided for v1

- **Deployment:** local-first / self-hosted, single user, `docker compose up`
- **Asset classes:** stocks and ETFs (schema stays extensible to crypto, cash and manual assets)
- **Imports:** broker CSV/XLSX upload and PDF statements, plus manual entry as the fallback
- **Stack:** TypeScript end to end — Next.js, PostgreSQL, Drizzle

## Open decisions

Listed at the end of each document. The ones that block the most work are which brokers
to support first, base currency, and cost-basis method.
