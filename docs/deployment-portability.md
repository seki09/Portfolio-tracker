# Deployment Portability

**Goal:** one codebase, two deployment targets. `docker compose up` on your own machine
today; a serverless host (Netlify + managed Postgres) whenever you want it — with no fork,
no rewrite, and no parallel code path. Only configuration changes.

This is achievable, but only if five seams are built in from the start. Retrofitting them
later means touching every job, every upload path and every database call.

---

## 1. Why a straight lift-and-shift fails

The original plan assumes a machine you own: an always-on process, a writable disk, a
database on localhost. Netlify (like Vercel, Cloudflare and AWS Lambda) gives you none of
those. Each constraint has a specific seam that neutralises it.

| Assumption that works locally | Why it breaks on Netlify | Seam |
| --- | --- | --- |
| A long-running `node-cron` worker | No always-on process exists; code runs only in response to a request | Jobs as idempotent HTTP handlers + a scheduler adapter (§2.3) |
| Uploads written to a mounted volume | The filesystem is per-invocation and ephemeral; `/tmp` does not survive | `BlobStore` interface (§2.2) |
| A module-level Postgres connection pool | Many short-lived instances exhaust the connection limit | Driver adapter + pooled/HTTP connection (§2.1) |
| A request that spends 40 s parsing a PDF | Synchronous functions are capped at ~10 s (extendable to ~26 s) | Chunked, resumable jobs + async parse (§2.3) |
| In-memory caches shared across requests | Every invocation may be a cold instance | Cache in Postgres — already the design |
| A 30 MB XLSX posted to a route handler | Request bodies are capped at ~6 MB | Direct-to-blob upload with a signed URL (§2.2) |
| `process.env` read wherever convenient | Build-time and runtime environments differ; secrets can be inlined into the client bundle | Validated runtime config module (§2.4) |
| A server-side session table or in-memory map | No sticky routing between invocations | Stateless signed cookie (§2.5) |

> Platform quotas as of writing — verify against Netlify's current limits before relying on
> a specific number. The design deliberately does not depend on any of them being generous.

## 2. The five seams

Each is a small interface with two implementations, selected once at startup by
`DEPLOY_TARGET`. Nothing above these interfaces knows which target it is running on.

### 2.1 Database driver adapter

```ts
// packages/db/client.ts
export const db = config.DEPLOY_TARGET === "serverless"
  ? drizzle(neon(config.DATABASE_URL))        // HTTP driver, no persistent socket
  : drizzle(new Pool({ connectionString: config.DATABASE_URL }));  // node-postgres
```

Same Drizzle schema, same queries, same migrations — only the driver differs. Two rules
the application code must follow for this to hold:

- **No transactions that span HTTP requests.** Every unit of work commits within one
  handler. The import pipeline already works this way (staging rows are persisted, not held
  open), which is what makes it portable for free.
- **Use the pooled connection string** in serverless mode (Neon's pooler, Supabase's
  PgBouncer endpoint). Without it, cold-start fan-out exhausts Postgres connections under
  even light use.

Managed Postgres candidates: **Neon** (best fit — HTTP driver, scale-to-zero, generous free
tier), Supabase, or any Postgres reachable over TLS. Staying on real Postgres rather than
SQLite is what makes this portable at all, so the original choice already paid off here.

### 2.2 Blob storage adapter

```ts
export interface BlobStore {
  put(key: string, data: Buffer | ReadableStream, meta?: BlobMeta): Promise<void>;
  get(key: string): Promise<ReadableStream>;
  delete(key: string): Promise<void>;
  /** Pre-signed direct upload, bypassing the function request-size limit. */
  createUploadUrl(key: string, contentType: string): Promise<{ url: string; fields?: Record<string,string> }>;
}
```

Implementations: `LocalDiskBlobStore` (the mounted volume) and `NetlifyBlobsStore`
(or any S3-compatible store, which keeps Fly/Railway/Vercel open too).

`createUploadUrl` is the part that is easy to skip and painful to add later. A year of IBKR
activity statements or a multi-megabyte PDF will exceed the ~6 MB request cap, so **the
browser must upload directly to the blob store and then hand the server a key**. Build the
upload path that way from day one and it works identically on both targets — local disk
just returns a URL to a route handler that streams to the volume.

### 2.3 Job runtime adapter

This is the seam that matters most, because it is the one the current plan gets wrong for
serverless. Jobs stop being "things the worker does on a timer" and become **pure,
idempotent, resumable HTTP handlers**:

```ts
export interface Job {
  name: string;                                  // "prices.eod"
  run(ctx: JobContext, cursor?: Cursor): Promise<JobResult>;
}
export type JobResult = { done: boolean; cursor?: Cursor; processed: number };
```

Every job is:

- **Idempotent** — running it twice produces the same state. Prices upsert by
  `(security_id, on_date)`; series rebuilds are derived from a watermark. Already true in
  the current design.
- **Chunked and resumable** — it processes a bounded slice (say 25 securities, or 90 days
  of series), returns `{ done: false, cursor }`, and the scheduler re-invokes it until
  `done`. This is what keeps a job inside a 10-second budget without needing background
  functions (which on Netlify are a paid-plan feature — better not to depend on them).
- **Invoked over HTTP** at `POST /api/jobs/:name`, authenticated by a shared secret header.

Then the scheduler is trivially swappable:

| Target | Scheduler |
| --- | --- |
| Local / Docker | `worker` container running `node-cron`, calling the same HTTP endpoints (or the job functions directly) |
| Netlify | Scheduled Functions (`export const config = { schedule: "0 22 * * *" }`) that POST to the same endpoints and loop on the returned cursor |
| Anywhere | `curl` from an external cron, GitHub Actions, or a manual "Run now" button in Settings → System |

The "Run now" button is worth building regardless: it makes jobs debuggable locally, and on
a cloud host it is the fallback when a platform scheduler misbehaves.

**Async import parsing** falls out of this. Instead of parsing inside the upload request,
the upload creates an `import_batch` with `status = PARSING` and enqueues a parse job; the
review screen polls until staged rows appear. Slightly more work than parsing inline, and
it removes the timeout risk entirely — while also giving the local build a progress
indicator for a 5,000-row file, which it wanted anyway.

### 2.4 Configuration module

One `packages/shared/config.ts`, zod-validated, read at runtime, never at module-eval time
in client-reachable code:

```ts
export const config = ConfigSchema.parse({
  DEPLOY_TARGET: process.env.DEPLOY_TARGET ?? "container",   // container | serverless
  DATABASE_URL:  process.env.DATABASE_URL,
  BLOB_DRIVER:   process.env.BLOB_DRIVER ?? "disk",          // disk | netlify | s3
  JOB_SECRET:    process.env.JOB_SECRET,
  PRICE_PROVIDER: process.env.PRICE_PROVIDER ?? "yahoo",
  PRICE_API_KEY: process.env.PRICE_API_KEY,
  BASE_CURRENCY: process.env.BASE_CURRENCY ?? "EUR",
});
```

Fail fast and loudly on a missing variable at boot. A cloud deploy that half-works because
`JOB_SECRET` was never set is a much worse outcome than one that refuses to start.

### 2.5 Stateless sessions

Argon2-hash the configured password; issue a signed, HTTP-only, `Secure` cookie carrying
only an expiry and a version counter. No session table, no sticky routing, no shared memory
— works identically on both targets. Bumping the version counter in config invalidates every
existing session, which is the whole of "log out everywhere".

## 3. Rules the code must follow

Short enough to be a review checklist, and the grep-able ones belong in CI:

1. No `fs` writes anywhere outside the `BlobStore` implementation.
2. No `setInterval`, `setTimeout` beyond a request, or `process.on` in application code.
3. No module-level mutable state that assumes it survives between requests. (A lazily
   created DB client is fine; a warm in-memory cache of prices is not.)
4. Every job handler is idempotent and returns `{ done, cursor }`.
5. Routes that touch `pdfjs-dist`, `exceljs` or the money core declare
   `export const runtime = "nodejs"` — never the edge runtime.
6. Secrets are read only through `config`, only server-side, never via `NEXT_PUBLIC_*`.
7. No request handler is allowed to be unboundedly long-running; if work can grow with the
   data, it is a chunked job instead.

Rules 1, 2, 5 and 6 are enforceable with ESLint `no-restricted-imports`/`no-restricted-syntax`
plus a CI grep. Cheap, and they stop the portability from quietly rotting.

## 4. Netlify specifics

```toml
# netlify.toml
[build]
  command = "pnpm build"
  publish = "apps/web/.next"

[[plugins]]
  package = "@netlify/plugin-nextjs"

[functions]
  node_bundler = "esbuild"
  external_node_modules = ["pdfjs-dist", "exceljs"]   # keep them out of the bundle graph
```

- `@netlify/plugin-nextjs` handles App Router, Server Components and route handlers; no
  custom server needed.
- **Scheduled Functions** live in `netlify/functions/` and POST to `/api/jobs/:name`,
  looping on the cursor until `done` or the time budget is nearly spent — then simply
  letting the next tick continue, since jobs are resumable.
- **Netlify Blobs** backs `BlobStore` with no extra account or credentials.
- Cold starts are the honest cost: expect ~1–2 s on the first request after idle. For a
  portfolio you check a few times a day this is acceptable; if it ever is not, the same
  build runs on Fly.io as a container without touching the code.

**Rough monthly cost:** Netlify free tier + Neon free tier + a free price-data tier is
plausibly €0 for single-user use. The realistic first paid line is the price provider, not
the hosting.

## 5. What cloud hosting costs you, honestly

The original pitch was "no telemetry, no outbound calls, your data never leaves your
machine". Deploying to Netlify trades part of that away, and the docs should say so plainly
rather than quietly dropping the claim:

- Your **full transaction history and net worth live on someone else's infrastructure**,
  encrypted at rest with the provider's keys, not yours.
- **Broker PDFs are the sharp edge.** They routinely contain account numbers, IBANs, your
  address and your tax ID. Recommendation: in serverless mode, default to **parse-then-
  discard** — keep the extracted transactions and the file hash for duplicate detection,
  but do not retain the source PDF. Make retention an explicit opt-in setting, and when it
  is on, encrypt blobs client-side with a key held in `config` so the storage provider holds
  only ciphertext. This is the one place where the cloud target should behave differently
  from local by default, and it is a deliberate product decision, not a limitation.
- A compromised `JOB_SECRET` or password exposes everything, with no VPN in front of it.
  Cloud mode should therefore require a password of real length and consider adding TOTP —
  a note for whenever cloud deployment actually happens, not for v1.

## 6. Deliberately still out of scope: multi-user

Serverless hosting and multi-tenancy are separate questions, and this document only answers
the first. The app stays **single-user**: one deployment, one password, one portfolio.

If that ever changes, the migration is mechanical but not small — an `owner_id` on eight
tables, a scoping clause on every query, real auth with registration and password reset,
and per-user rate limiting on the price provider. Roughly one to two weeks. Adding the
column speculatively now would put a join key and a filter on every query for a feature you
have not asked for, so the recommendation is to skip it and accept the later cost.

## 7. Impact on the milestone plan

The seams are folded into the existing milestones rather than bolted on at the end, because
that is precisely the difference between four days and two weeks:

| Milestone | Added work | Cost |
| --- | --- | --- |
| **M0** | Config module + zod validation; DB driver adapter; the lint rules from §3 | +1 day |
| **M2** | Jobs as HTTP handlers with cursors; local cron calls them over HTTP; "Run now" in Settings | +1 day |
| **M3** | `BlobStore` interface + disk implementation; direct-to-blob upload path; async parse with a `PARSING` state | +2 days |
| **M7** *(new, optional)* | Netlify adapter: `netlify.toml`, Scheduled Functions, Netlify Blobs impl, Neon setup, deploy docs, parse-then-discard default | ~3 days, whenever you want it |

Done this way, cloud deployment is a new package and a config file — not a refactor. Done
later, it is a rewrite of the import pipeline and every job.

The local Docker path stays the primary, best-supported target throughout. Nothing here
compromises it; the seams are useful locally on their own merits (async parse gives you
progress bars, "Run now" gives you debuggable jobs, the config module gives you a startup
check that actually catches misconfiguration).
