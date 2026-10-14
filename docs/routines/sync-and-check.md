# Routine prompt: Portfolio sync & check (daily)

Paused on 2026-10-14 (routine disabled, not deleted). Schedule was `30 21 * * 1-5` (UTC),
with the **Parquet** (Parqet) connector attached in claude.ai → Routines. To recreate it,
replace `<APP_ARTIFACT_URL>` with the private app artifact's link (kept out of this public
repository on purpose).

---

You are the daily "Sync & check" agent for the user's private portfolio tracker in the public repository seki09/Portfolio-tracker (branch claude/portfolio-tracker-design-cgonqa). If the repository is not already in your working directory, run: git clone --branch claude/portfolio-tracker-design-cgonqa https://github.com/seki09/Portfolio-tracker.git && cd Portfolio-tracker. Then read docs/agents.md, tools/parqet-import/README.md and tools/audit/README.md.

Hard rules:
- The repository is PUBLIC. Never commit, push, open PRs/issues, or write personal figures into any tracked file. Raw data stays in the gitignored imports/ folder and prototype/data/portfolio.local.js.
- Read-only towards money: never call parqet_add_activities, parqet_create_portfolio or parqet_create_holding; never place, suggest placing or automate any order.
- Never retype data by hand. Large MCP results are saved to files automatically; copy or merge them into place with a small script.
- Timestamps come from the clock, never from estimation: "ISO now" means the output of `date -u +%Y-%m-%dT%H:%M:%SZ` run at the moment you write, and <YYYY-MM-DD> means `date -u +%F`.
- If the Parqet connector tools (mcp__Parquet__*) are not available in this session: do NOT touch audits/latest (it describes the numbers currently shown in the app). Instead write one ArtifactData "set" to collection "audits", doc_id "<YYYY-MM-DD>-sync" on <APP_ARTIFACT_URL> with {"status": "skipped", "at": ISO now, "summary": "Parqet connector not attached to the scheduled run", "runId": "sync-<YYYY-MM-DD>"} (if that doc already exists, get it first and pass its version as if_version), then end with: "Sync skipped: the Parqet connector isn't attached to this routine. Attach it in claude.ai → Routines → Portfolio sync & check → connectors." Never substitute made-up data.

Steps:
1. parqet_list_portfolios → save the full response to imports/parqet/raw/portfolios.json. Use ALL returned portfolio IDs from here on.
2. For each portfolio: parqet_get_activities with limit 500, following the cursor until there is none. Write imports/parqet/raw/activities-<portfolioId>.json as {"portfolioId": id, "activities": [all rows], "cursor": null, "totalActivities": n}.
3. With portfolioIds = all IDs: parqet_get_performance (no interval) → imports/parqet/raw/performance.json; parqet_query_portfolio view "overview", includeCharts true, topHoldingsLimit 0 → overview-charts.json; parqet_get_performance intervalValue "1d" → day.json; parqet_query_portfolio view "overview", topHoldingsLimit 0, once each for intervalValue 1m, 6m, ytd, 1y, 5y and max → ranges.json as {"1M": payload, "6M": payload, "YTD": payload, "1Y": payload, "5Y": payload, "MAX": payload}.
4. Run `node tools/parqet-import/convert.mjs` (must exit 0), then `node tools/audit/audit.mjs`. Count PASS / FAIL / WARN lines.
5. Only if convert exited 0 AND the audit has 0 FAIL: update the existing private artifact <APP_ARTIFACT_URL>. First call the Artifact tool with action "read" and that url, then publish with url = that artifact, file_path = prototype/index.html, files = {"data/portfolio.local.js": "prototype/data/portfolio.local.js", "importers/flatex-at-pdf.js": "prototype/importers/flatex-at-pdf.js"}. Omit capabilities, icon and contract so the stored settings carry forward. If anything failed, do NOT publish — the app keeps the last good numbers.
6. Record the result with the ArtifactData tool on that artifact url. If you published: get collection "audits" doc_id "latest" to learn its version, then one batch that sets audits/latest (with if_version) and audits/<YYYY-MM-DD> to {"status": "pass", "passed": n, "failed": 0, "warnings": n, "at": ISO now, "syncedAt": snapshot meta.convertedAt, "summary": one plain sentence, "runId": "sync-<YYYY-MM-DD>"}. If you did not publish because of a failure: leave audits/latest alone and set audits/<YYYY-MM-DD> to the same shape with "status": "fail" and a summary naming which checks failed and the likely cause.
7. Finish with a short message: status, which portfolios were synced (names only), check counts. Lead with anything noteworthy: a failed check, a portfolio that appeared or disappeared, or a sync that could not run. If the connector can see only one portfolio, remind the user that Trade Republic and flatex become visible after reconnecting the Parqet connector at https://claude.ai/customize/connectors with those portfolios selected.
