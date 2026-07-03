# Architecture & Current State

This is the curated, tracked architecture reference for the scRNA-seq Workbench.
It is the authoritative map of what is actually wired up today. `README.md` is the
short entry point; this file holds the detailed status table and boundary policies.

Keep this file honest: when a subsystem moves between backend-only and UI-wired,
update the table below in the same change.

## Runtime shape

```text
Browser (React/Vite)
  -> Express API (auth, authorization, DB, uploads, R proxy)
  -> R Plumber/Seurat backend (compute only, localhost/private)
```

Express is the authentication and authorization boundary. The R backend trusts
only server-injected headers such as `X-API-Token` and server-derived
`X-Object-ID`; it must not be exposed directly to users or the public network.

## Implemented vs UI-wired

The backend has moved ahead of the React UI. Several subsystems are fully
implemented and tested at the API/DB layer but are **not yet surfaced in the
app**. This table is the authoritative, honest map so future work does not
confuse "implemented and tested" with "usable in the UI".

Status legend:

- **UI-wired** — reachable and used through the React app today.
- **backend-only** — implemented and tested in Express/SQLite (and covered by
  CI backend tests), but no React UI surfaces it yet.
- **legacy/prototype** — older path still present; kept for now, not the
  intended durable product workflow.
- **not implemented** — intentionally out of scope in the current code.

| Subsystem | Status | Notes |
| --- | --- | --- |
| Auth / logout | UI-wired (cookie foundation) | HttpOnly session cookie is the source of auth truth (login/signup set it; `GET /api/auth/session` restores it; `POST /api/auth/logout` clears it). The localStorage bearer token is deprecated legacy/dev compatibility, still accepted in a transition mode. CSRF for cookie-auth mutations is a SameSite=Lax cookie + an allowed-origin check. Server-side session **revocation/versioning** is still future work (stateless HMAC token). |
| Organizations / projects | UI-wired | A personal org/project is auto-created for the live-load flow. |
| Project members / RBAC endpoints | backend-only | Role-checked member APIs exist and are tested. The in-app "Collaborators" panel is a disabled status surface and is **not** wired to these endpoints. |
| Project-scoped datasets | backend-only | Upload with server-chosen storage key + sha256; no UI dataset manager. |
| DB-backed analysis objects (`ao_*`) | UI-wired | Created/selected via the workspace; authoritative object identity. |
| Live R object state | UI-wired | Private, transient, keyed by server-derived user/object state. |
| QC / Normalize / PCA / Cluster / UMAP / plots | UI-wired | Run through the authenticated live-R proxy (`/api/r/*`). |
| DEG (differential expression) | UI-wired (legacy path) | UI calls the legacy live-R endpoint `/api/r/deg`. See "DEG paths" below. |
| Durable DEG worker (`deg.find_markers.v1`) | backend-only | Durable, allowlisted worker job + `r.deg.find_markers.v1` bridge op. Not wired into the UI. |
| Durable jobs | UI-wired (read-only metadata) | Durable ownership-scoped job records + API are shown in Jobs & Artifacts. The UI does not create, cancel, or retry jobs. |
| Job worker loop | backend-only (opt-in) | Off unless `ENABLE_JOB_WORKER="true"`; drains only registered, allowlisted handlers. |
| PBMC pipeline worker (`pbmc.pipeline.v1`) | backend-only | Copy-on-modify Seurat preprocessing as a durable job; not wired into the UI. |
| Checkpoint artifacts | UI-wired (read-only metadata) | Immutable result checkpoint metadata per successful job can be listed. The UI does not load checkpoints. |
| Checkpoint load worker (`checkpoint.load.v1`) | backend-only | Owner-only reattach of a server-selected checkpoint into live R; not wired into the UI. |
| Job artifacts (metadata) | UI-wired (read-only metadata) | Read-only, path/storage-key stripped from responses; no download route. Jobs & Artifacts renders sanitized metadata only. |
| Analysis-object lineage DAG | UI-wired (read-only summary) | Edge model + parents/children/lineage read routes are surfaced as a bounded summary in Jobs & Artifacts. Mutations remain server/worker-driven. |
| Provenance / figures / cache | UI-wired | Older `/api/db/*` routes still back the live gallery/cache path. Jobs & Artifacts also shows project-scoped provenance and figure metadata read-only. |
| Runtime check / object inspect workers | backend-only | Read-only, metadata-only bridge operations. |
| Pathway enrichment | not implemented (product) | No durable workflow. A legacy authenticated R endpoint may still exist (see below). |
| CellChat / cell-cell communication | not implemented (product) | No durable workflow. Legacy authenticated R endpoints may still exist (see below). |
| Cell annotation | not implemented (product) | UI placeholder only. A legacy authenticated R endpoint may still exist (see below). |
| Custom Script / arbitrary R execution | not implemented | Out of scope; no arbitrary-R endpoint. |
| Reports / generated R scripts | not implemented | No supported report or script-export surface. Legacy live-R provenance script preview is copy-only and not a complete reproducibility export. |
| Artifact downloads | not implemented | No public download route; responses never expose storage paths/keys. |
| Object storage | not implemented | Local vault only; no external object storage. |
| Secure cookie sessions | backend-wired (transitional) | HttpOnly + SameSite + Secure-in-production session cookie is set on login/signup and accepted on every route; frontend restores via `/api/auth/session`. localStorage bearer is deprecated fallback. Session revocation/versioning not yet implemented. |
| Postgres database path | backend-only (expanded foundation) | `backend/pgDatabase.js` + `backend/pg/schema.sql` provide a broader Postgres data layer + schema for users, projects/members, datasets, analysis objects, project jobs/logs/artifacts, and lineage. SQLite is still the app runtime; this is not a full runtime cutover. See "Database backend" below. |
| Shared project live R state | not implemented | Collaboration is via durable metadata, never a shared live R session. |

## DEG paths (two implementations)

There are currently two DEG implementations, and only one is wired into the app:

- **UI today:** the React DEG page calls the **legacy live-R path** `/api/r/deg`
  through the authenticated proxy. This runs synchronously against the caller's
  private live object.
- **Backend-only:** a **durable, worker-backed** DEG implementation
  (`deg.find_markers.v1` job + `r.deg.find_markers.v1` bridge operation) exists
  and is tested, but is **not** wired into the UI.

Neither path is removed, and the UI is not migrated to the worker.

## Hidden/disabled features vs reachable R endpoints

Pathway enrichment, CellChat, and cell annotation are **not
production-integrated** and are **not exposed as supported UI workflows** (the
UI shows placeholders). However, some **legacy authenticated R endpoints may
still be reachable behind the R proxy** for development/legacy use — for example
`/api/r/cellchat`, `/api/r/cellchat-infer`, `/api/r/enrichment`,
`/api/r/annotate-clusters`, and `/api/r/deg`. These are owner-scoped (they still
require auth and a server-verified `X-Object-ID`) but are **not** the durable
product workflow and should not be treated as a supported feature surface.

By contrast, the internal worker-only R endpoints
(`/api/r/object/pbmc-pipeline`, `/api/r/object/checkpoint-load`,
`/api/r/object/deg-find-markers`) are **blocked** from the public proxy before
any R contact (404, no existence leak); they run only through the in-process
worker bridge. The current policy is pinned by `backend/r-proxy-policy.test.js`.

## RDS loading is a trusted-input boundary

The R backend has a legacy `.rds` object loader (`/api/r/load-rds`), but it is
fail-closed by default at the Express boundary and again in R. **RDS
deserialization can execute arbitrary R code.** Set `ALLOW_TRUSTED_RDS_LOAD=true`
only for trusted local/dev inputs; the route remains owner-scoped and
path-validated (confined to the per-user vault), but it is not safe for
untrusted uploads until stronger sandbox/container isolation exists. Worker
checkpoint loading is a separate internal path for server-created checkpoints.

## Database backend

The app is mid-migration from SQLite to Postgres for the hosted service.

- **Runtime today:** SQLite (`backend/database.js`), loaded by `server.js`. This
  is the temporary local/test fallback, not the intended hosted-service database.
- **Postgres foundation:** `backend/pg/schema.sql` is the Postgres translation of
  the durable schema (same tables, server-owned identity, role/scope columns, job
  state-machine + worker-coordination columns, artifact immutability, lineage DAG).
  `backend/pgDatabase.js` is an async `pg` data layer implementing a broader
  parity slice for users, orgs/projects/members, datasets, analysis objects,
  project-scoped jobs/logs/artifacts, and lineage reads/edges, with public
  projections that strip claim tokens, worker internals, storage keys/URIs, and
  object hashes. Provenance, figures/cache, and worker claim/lease helpers are
  still not fully ported.
- **Backend selection** is via `DATABASE_BACKEND` (`sqlite` | `postgres`) or
  inferred from `DATABASE_URL` (see `backend/config.js`). Selecting `postgres`
  does not yet switch the running server — porting the full route/DB call surface
  off synchronous better-sqlite3 onto the async `pg` layer is the next branch.
- **Schema init:** `npm run init:postgres` applies `schema.sql` idempotently
  (`DATABASE_URL` or `PG*` env). It does **not** migrate existing SQLite dev data:
  local SQLite state is disposable dev/test data (gitignored `*.db`), so a fresh
  Postgres database starts empty and users/projects are re-created through the
  normal signup/create flows.
- **Local Postgres:** `docker compose up postgres` (localhost-only) or any local
  Postgres; then `DATABASE_URL=postgres://scrna:scrna@localhost:5432/scrna npm run init:postgres`.
- **Evidence:** `backend/postgres-contract.test.js` runs against a real Postgres
  (CI service + `npm run test:backend:postgres`) and SKIPS cleanly when no
  Postgres is configured, so the default SQLite `npm run test:backend` stays green.

## State & storage boundaries

- Browser auth is now an **HttpOnly session cookie** (source of truth); the
  localStorage bearer token is deprecated legacy/dev compatibility accepted in a
  transition mode. CSRF for cookie-authenticated state-changing requests is
  SameSite=Lax + an allowed-origin check (`FRONTEND_ORIGIN`). Server-side session
  revocation/versioning is not yet implemented (the token is a stateless HMAC);
  project role/membership is still re-checked on every project-scoped request.
  SameSite=Lax is intended for same-site/local deployments (API and frontend on
  the same origin). For cross-origin hosted deployments — API and frontend on
  different origins — cookie auth requires an explicit `COOKIE_SAMESITE=None` +
  `COOKIE_SECURE=true` configuration, a correct `FRONTEND_ORIGIN` allowlist, and
  HTTPS; config validation refuses `SameSite=None` without Secure cookies and,
  in production, refuses non-HTTPS frontend origins for cross-site cookies. The
  frontend no longer treats cached localStorage bearer/user data as login truth;
  it starts from `/api/auth/session`, while still sending the legacy bearer as a
  transition fallback.
- Durable project resources use **server-owned, project-scoped storage keys**
  (`backend/storage.js`, `projects/<projectId>/<kind>/<id>`): server-generated,
  normalized POSIX-style, traversal-proof, never client-supplied, and never
  returned in a public response (serializers strip `storage_uri`,
  `internal_storage_key`, and object hashes). Storage key resolution rejects
  absolute paths, Windows-style paths, NUL bytes, percent-encoded traversal, and
  ambiguous path segments. Production config validation also rejects overlapping
  storage/vault roots and malformed upload limits. This is a local filesystem
  convention today; the key format is provider-agnostic so a future object-storage
  backend can adopt it without changing callers. No object storage and no public
  downloads are introduced.
- Backend projects, DB-backed analysis objects, jobs, artifacts, checkpoints,
  and lineage are the durable source of truth **at the API/DB layer**. Projects
  and analysis objects are active UI surfaces; jobs, artifacts, checkpoints, and
  lineage are visible as read-only metadata in Jobs & Artifacts. Datasets, RBAC
  management, checkpoint loading, and worker job launch/cancel flows remain
  backend-only (see the table above).
- localStorage may cache selected project/object IDs and UI preferences only; it
  is not authoritative for projects, analysis objects, lineage, jobs, roles, or
  checkpoints.
- Live R state is private, transient, and keyed by server-derived user/object
  state. Project metadata visibility does not grant live R access.
- The worker is opt-in and allowlisted. Registered handlers include PBMC
  pipeline, checkpoint load, DEG marker finding, runtime check, and object
  inspection — none of these worker workflows are wired into the UI yet.
- There is no public artifact download surface, object storage, generated report
  export, arbitrary R execution, or shared project live R state.
- R 4.5.x is the intended local development target; the Dockerfile pins R 4.5.3
  with Bioconductor 3.22. Report if R 4.6.x is detected.

## Testing & CI notes

- `npm run test:backend` runs the full `backend/*.test.js` suite. These are
  **backend contract tests**: they exercise the real Express + SQLite stack,
  including backend contract coverage for worker coordination, datasets, RBAC,
  and the durable jobs/artifacts/lineage APIs. Durable jobs, artifacts/checkpoints,
  and lineage are implemented in the backend. The React UI now includes a
  read-only Jobs & Artifacts / durable history surface for safe metadata
  visibility, but job launching, checkpoint loading, artifact downloads, and
  lineage mutation are still not UI-wired. A passing backend suite
  means the API/DB contract holds — **not** that a feature is surfaced in the UI.
- `npm run test:visual` is a **mocked** frontend visual smoke test: it renders
  the built UI with backend and R responses mocked in the browser. It checks
  rendering/layout and obvious UI regressions only, and is **not** integration
  or security evidence. It runs in CI.
- `npm run test:visual:db-flow` drives the DB-backed project/object UI flow with
  **all `/api/*` responses mocked** via Playwright route interception and a fake
  auth token. It requires a browser (Playwright/Chromium) + Vite, is **not run
  in CI**, and is best used as a **local pre-merge smoke test** for branches that
  change the project/object UI flow. It proves the UI *model* wiring (what the
  app requests and how it renders responses); it does **not** prove real
  backend, auth, ownership, or tenant isolation.
- The R/workflow checks (`test:r-state-proxy`, `test:pbmc-parent`,
  `test:checkpoint-load`, `test:deg-markers`) exercise the hardened live paths
  and require a real R/Seurat backend; they skip cleanly when Seurat is absent.
- CI runs on `pull_request` and `workflow_dispatch` only. The security-critical
  suites are additionally named explicitly in the workflow so their regression
  coverage is auditable.
