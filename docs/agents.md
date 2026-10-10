# Scheduled agents

Two Claude routines keep the tracker current. Both run in a fresh cloud session, read the
portfolio through the Parqet connector, and write **only to the private artifact** — never
to this public repository, never to Parqet, and never to a broker.

| Agent | Schedule (UTC) | Does | Writes to |
| --- | --- | --- | --- |
| **Sync & check** | Mon–Fri 21:30 (after the US close) | Captures every Parqet portfolio the connector can see, rebuilds the combined snapshot, runs the independent audit, republishes the app's data | Artifact data file `data/portfolio.local.js` (only if the audit passes) and data store doc `audits/latest` (+ `audits/<date>`) |
| **Weekly review** | Sun 07:00 | Reads the latest snapshot and audit, looks for concentration, cost, tax and housekeeping issues, writes 2–4 concrete observations | Data store collection `insights`; a short push/email summary |

## Guarantees

- **Read-only towards money.** Neither agent calls a Parqet write tool (`add_activities`,
  `create_portfolio`, `create_holding`) or places, suggests placing, or automates any order.
- **No stale numbers.** Sync & check publishes a new snapshot only when every audit check
  passes. On failure it keeps the last good snapshot, records which checks failed in
  `audits/latest`, and notifies — the app then shows the failure next to the figures.
- **No personal data in git.** Payloads stay in the session's gitignored `imports/`; the
  repository is never committed to or pushed by either agent.
- **New portfolios are picked up automatically** — but only those the Parqet connector has
  been granted. A portfolio created in Parqet later is invisible until the connector is
  reconnected with it selected.

## Insight format

Each row in `insights`: `{ title, body, kind, impact?, createdAt, runId }`, with `kind` one of
`risk`, `cost`, `tax`, `idea`, `housekeeping`. Bodies are short (≤ 600 characters), cite the
portfolio's own figures, state trade-offs, and are observations — not personal financial
advice. Austrian context is assumed: 27.5 % KESt, losses offset gains only within the same
calendar year and depot holder, reporting-fund status matters for ETFs.

## Running the same steps by hand

```sh
# after capturing payloads into imports/parqet/raw (see tools/parqet-import/README.md)
node tools/parqet-import/convert.mjs
node tools/audit/audit.mjs
```
