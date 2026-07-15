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
- **backend-only** — implemented and tested in Express/Postgres (and covered by
  CI backend tests), but no React UI surfaces it yet.
- **legacy/prototype** — older path still present; kept for now, not the
  intended durable product workflow.
- **not implemented** — intentionally out of scope in the current code.

| Subsystem | Status | Notes |
| --- | --- | --- |
| Auth / logout | UI-wired (cookie foundation) | HttpOnly session cookie is the source of auth truth (login/signup set it; `GET /api/auth/session` restores it; `POST /api/auth/logout` clears it). The localStorage bearer token is deprecated legacy/dev compatibility, still accepted in a transition mode. CSRF for cookie-auth mutations is a SameSite=Lax cookie + an allowed-origin check. Server-side session **revocation/versioning** is still future work (stateless HMAC token). |
| Organizations / projects | UI-wired | A personal org/project is auto-created for the live-load flow. |
| Project members / RBAC | UI-wired | Collaborators lists project members for every role and lets owners/admins add existing users, change permitted roles, and remove permitted members. Owner-only owner changes, last-owner protection, non-member 404s, insufficient-role 403s, and server-controlled identities remain backend enforced. This is immediate account membership, not an invitation-token/delivery workflow. |
| Project-scoped datasets | UI-wired (narrow Seurat path) | The Pipeline Manager Seurat panel lists/uploads `tenx_h5` datasets for one supported workflow. General dataset management remains absent. New uploads use server-owned project storage keys plus SHA-256 checksums, and public responses omit internal storage. |
| DB-backed analysis objects (`ao_*`) | UI-wired | Created/selected via the workspace; authoritative object identity. |
| Live R object state | UI-wired | Private, transient, keyed by server-derived user/object state. |
| Pipeline Manager / pipeline manifests | UI-wired (declarative registry) | A Pipeline Manager tab lets each user select an active pipeline within a project, upload declarative pipeline manifests, and populate pipeline-generated sidebar tabs from registered modules. Upload is currently allowed to project owners/admins/analysts, not a separate platform-developer role. Uploaded manifests may choose from registered modules/templates only; arbitrary code, endpoints, icons, storage keys, and paths are rejected. Parameter/result template declarations are validated and displayed, but there is not yet a fully generic template-driven execution/result renderer. |
| QC / Normalize / PCA / Cluster / UMAP / plots | UI-wired | Run through the authenticated live-R proxy (`/api/r/*`). |
| DEG (differential expression) | UI-wired (durable worker path) | The primary DEG UI creates project-scoped `deg.find_markers.v1` jobs and reads job status, logs, and bounded `deg_summary` artifact metadata. It does not call legacy `/api/r/deg` for the main workflow. See "DEG paths" below. |
| Durable DEG worker (`deg.find_markers.v1`) | UI-wired | Durable, allowlisted worker job + `r.deg.find_markers.v1` bridge op. The DEG tab launches this job and displays sanitized summary metadata only; full marker tables remain internal and are not downloadable. |
| Durable Seurat pipeline worker (`seurat.pipeline.v1`) | UI-wired (10x HDF5 only) | Pipeline Manager can upload/select one `tenx_h5` dataset, create/reuse a raw dataset analysis object, launch a durable Seurat preprocessing job, show logs/status/safe summary metadata, and hand the result to checkpoint load or DEG. See "Seurat pipeline path" below. |
| Durable jobs | UI-wired (metadata + selected launches) | Durable ownership-scoped job records + API are shown in Jobs & Artifacts. The DEG tab can create `deg.find_markers.v1`; Pipeline Manager can create `seurat.pipeline.v1` and result `checkpoint.load.v1`; Jobs & Artifacts can create `checkpoint.fork.v1` when an object has exactly one available, local, loadable checkpoint. General job launch, cancel, and retry flows are not generally UI-wired. |
| Job worker loop | backend-only (opt-in, in-process) | Off unless `ENABLE_JOB_WORKER="true"`; drains only registered, allowlisted handlers. The local `npm run dev` script explicitly preloads this env var so UI-wired durable workflows run end-to-end; use `npm run dev:no-worker` for UI/API/R only. The queue supports multiple claimers through Postgres leases and `FOR UPDATE SKIP LOCKED`, but there is no standalone worker entrypoint or supported multi-worker deployment topology yet. Each loop handles one claimed job at a time. |
| PBMC pipeline worker (`pbmc.pipeline.v1`) | backend-only | Copy-on-modify Seurat preprocessing as a durable job; not wired into the UI. |
| Checkpoint artifacts | UI-wired (metadata + reattach/fork actions) | Immutable result checkpoint metadata per successful job can be listed. Pipeline Manager can request owner-only reattach through `checkpoint.load.v1`; project writers can request a private collaborator fork through `checkpoint.fork.v1`; there is still no download route. |
| Checkpoint load worker (`checkpoint.load.v1`) | UI-wired (Seurat result action) | Owner-only reattach of a server-selected checkpoint into live R. UI coverage is limited to the Seurat pipeline result panel; it is not a general checkpoint browser/launcher. |
| Checkpoint fork worker (`checkpoint.fork.v1`) | UI-wired (controlled checkpoint action) | When a project object has exactly one available `local_internal` checkpoint, a project writer may load that server-selected checkpoint into a new analysis object and private live R key owned by the writer. Ambiguous or unloadable checkpoint sets are rejected. The immutable source object/checkpoint remain unchanged; the child object and lineage edge record the source object, exact checkpoint artifact, fork job, and creating member. It never attaches the source owner's live state. |
| Job artifacts (metadata) | UI-wired (read-only metadata) | Read-only, path/storage-key stripped from responses; no download route. Jobs & Artifacts renders sanitized metadata only. |
| Analysis-object lineage DAG | UI-wired (read-only summary) | Edge model + parents/children/lineage read routes are surfaced as a bounded summary in Jobs & Artifacts. Mutations remain server/worker-driven. |
| Provenance / figures / cache | UI-wired | Older `/api/db/*` routes still back the live gallery/cache path. Jobs & Artifacts also shows project-scoped provenance and figure metadata read-only. |
| Runtime check / object inspect workers | backend-only | Read-only, metadata-only bridge operations. |
| Default visual theme | UI-wired | The React shell is light-first by default with the existing dark toggle retained. |
| Pathway enrichment | not implemented (product) | No durable workflow. A legacy authenticated R endpoint may still exist (see below). |
| CellChat / cell-cell communication | not implemented (product) | No durable workflow. Legacy authenticated R endpoints may still exist (see below). |
| Cell annotation | not implemented (product) | UI placeholder only. A legacy authenticated R endpoint may still exist (see below). |
| Custom Script / arbitrary R execution | not implemented | Out of scope; no arbitrary-R endpoint. |
| Reports / generated R scripts | not implemented | No supported report or script-export surface. Legacy live-R provenance script preview is copy-only and not a complete reproducibility export. |
| Artifact downloads | not implemented | No public download route; responses never expose storage paths/keys. |
| Object storage | not implemented | Local filesystem provider only; no external object storage. |
| Secure cookie sessions | backend-wired (transitional) | HttpOnly + SameSite + Secure-in-production session cookie is set on login/signup and accepted on every route; frontend restores via `/api/auth/session`. localStorage bearer is deprecated fallback. Session revocation/versioning not yet implemented. |
| Postgres database runtime | backend-wired | `backend/pgDatabase.js` + `backend/pg/schema.sql` are the app metadata runtime for users, projects/members, datasets, analysis objects, project jobs/logs/artifacts, provenance, figures/cache, and lineage. See "Database backend" below. |
| Shared project live R state | not implemented | Collaboration is via durable metadata, never a shared live R session. |

## DEG paths (two implementations)

There are currently two DEG implementations, but the React DEG page now uses the
durable worker path as its primary workflow:

- **UI today:** the React DEG page creates a project-scoped
  `deg.find_markers.v1` job, polls project job status/logs, and renders only
  sanitized `deg_summary` artifact metadata. Full raw marker tables are stored as
  internal `deg_markers` artifacts and are not downloadable.
- **Legacy/dev path:** `/api/r/deg` remains reachable behind the authenticated
  live-R proxy for temporary legacy/development compatibility. It is not the main
  DEG UI workflow and should not be treated as the durable product path.

Neither path is removed. The UI migration does not add public downloads,
generated reports/scripts, pathway enrichment, CellChat, or shared live R state.

## Seurat pipeline path

The first supported end-to-end local/dev pipeline is intentionally narrow:

- **Supported input:** one uploaded 10x Genomics filtered feature-barcode matrix
  HDF5 file, stored as dataset `fileType: "tenx_h5"` under a server-owned
  project storage key. Matrix Market folders/zips,
  H5AD, H5Seurat, RDS, multi-sample batches, and public downloads are not part of
  this v1 path.
- **UI workflow:** Pipeline Manager lists/uploads `tenx_h5` datasets, creates or
  reuses a DB-backed raw dataset analysis object with the same `datasetId`,
  launches a project-scoped `seurat.pipeline.v1` job, shows job status/logs and
  sanitized summary/checkpoint metadata, then can launch `checkpoint.load.v1` to
  reattach the result object into the owner's private live R state before
  downstream DEG.
- **R steps:** `Read10X_h5`, `CreateSeuratObject`, optional QC filtering,
  `NormalizeData` or `SCTransform`, variable features, scaling, PCA, neighbors,
  clusters, and UMAP. Parameter names are strictly allowlisted by
  `backend/seuratPipeline.js` before job creation and again before R contact.
- **Outputs:** a result `seurat` analysis object parented to the raw dataset
  object, one internal `checkpoint` artifact, one metadata-only
  `pipeline_summary` artifact, a lineage edge, and a job result link. Public API
  responses do not expose dataset storage keys, checkpoint storage keys, local
  paths, R state keys, matrices, embeddings, cell rows, or gene tables.
- **Worker boundary:** Express blocks `/api/r/object/seurat-pipeline` from the
  public R proxy before R contact. The endpoint is reachable only through the
  allowlisted in-process worker bridge, which reconstructs the body from trusted
  DB rows and server-allocated checkpoint keys.
- **Module boundary:** The default Seurat workflow is represented as a
  declarative pipeline manifest whose tabs map to registered frontend module
  templates and allowlisted job types. Most Seurat preprocessing steps still run
  through the full `seurat.pipeline.v1` worker path; standalone durable workers
  for every module step are future work. Uploaded manifests cannot introduce
  arbitrary code execution or unregistered backend endpoints.

This is local/dev pipeline evidence, not hosted-service production readiness.
There is no object storage, no public download route, no server-side session
revocation, no general dataset manager, and no live R state shared across project
members.

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
`/api/r/object/deg-find-markers`, `/api/r/object/seurat-pipeline`) are
**blocked** from the public proxy before any R contact (404, no existence leak);
they run only through the in-process worker bridge. The current policy is pinned
by `backend/r-proxy-policy.test.js`.

## RDS loading is a trusted-input boundary

The R backend has a legacy `.rds` object loader (`/api/r/load-rds`), but it is
fail-closed by default at the Express boundary and again in R. **RDS
deserialization can execute arbitrary R code.** Set `ALLOW_TRUSTED_RDS_LOAD=true`
only for trusted local/dev inputs; the route remains owner-scoped and
path-validated (confined to the per-user vault), but it is not safe for
untrusted uploads until stronger sandbox/container isolation exists. Worker
checkpoint loading is a separate internal path for server-created checkpoints.

## Database backend

The app runtime is Postgres-only.

- **Runtime today:** `server.js` loads `backend/pgDatabase.js`; startup refuses
  to run without `DATABASE_URL` or `PG*` connection settings.
- **Schema/data layer:** `backend/pg/schema.sql` is the durable schema for
  server-owned identity, role/scope columns, job state-machine + worker
  coordination, artifact immutability, provenance/figures/cache, and lineage DAG.
  `backend/pgDatabase.js` is the async `pg` data layer for users,
  orgs/projects/members, datasets, analysis objects, project jobs/logs/artifacts,
  provenance, figures/cache, and lineage. Public projections strip claim tokens,
  worker internals, storage keys/URIs, object hashes, and raw paths.
- **Backend selection:** `DATABASE_BACKEND` is accepted for readable summaries but
  always resolves to `postgres`; SQLite is no longer a runtime option.
- **Schema init:** `npm run init:postgres` applies `schema.sql` idempotently
  (`DATABASE_URL` or `PG*` env). Existing SQLite dev data is not migrated; a
  fresh Postgres database starts empty and users/projects are re-created through
  the normal signup/create flows.
- **Local Postgres:** `docker compose up postgres` (localhost-only) or any local
  Postgres; then `DATABASE_URL=postgres://scrna:scrna@localhost:5432/scrna npm run init:postgres`.
- **Evidence:** `npm run test:backend` includes the config contract,
  real-Postgres database contract, and live Express runtime smoke test. The
  Postgres-specific tests skip when no database is configured, but the server
  itself does not.

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
- `backend/storage.js` is the active local-filesystem provider for new durable
  datasets, checkpoints, and DEG tables. It uses server-owned keys shaped as
  `projects/<projectId>/<kind>/<id>/<file>` under `STORAGE_ROOT`. Writes are
  finalized atomically, checked by size and SHA-256, and blocked from following
  links outside the root. Keys are never client-supplied or returned publicly.
  Existing `vault/...` records remain readable; they are not silently rewritten.
  Production config rejects overlapping storage/vault roots and malformed upload
  limits. No external object storage and no public downloads exist.
- Backend projects, DB-backed analysis objects, jobs, artifacts, checkpoints,
  and lineage are the durable source of truth **at the API/DB layer**. Projects
  and analysis objects are active UI surfaces; jobs, artifacts, checkpoints, and
  lineage are visible as sanitized metadata in Jobs & Artifacts, which also
  exposes the narrow checkpoint-fork launch. The DEG tab can
  launch `deg.find_markers.v1` worker jobs and read sanitized DEG summary
  artifacts. The Pipeline Manager Seurat panel can list/upload `tenx_h5`
  datasets for `seurat.pipeline.v1`, launch that job, and request checkpoint
  reattach for the result object. General dataset management, generic worker job
  launch/cancel/retry flows, and artifact downloads remain
  backend-only or absent (see the table above).
- localStorage may cache selected project/object IDs and UI preferences only; it
  is not authoritative for projects, analysis objects, lineage, jobs, roles, or
  checkpoints.
- Live R state is private, transient, and keyed by server-derived user/object
  state. Project metadata visibility does not grant live R access.
- Legacy `/api/analysis-objects*` and `/api/jobs*` compatibility routes expose
  only genuinely private, projectless resources. Project resources and legacy
  descendants that trace to project data stay behind project RBAC routes, so
  immutable creator metadata cannot become a post-removal access bypass.
- The worker is opt-in and allowlisted. Registered handlers include PBMC
  pipeline, dataset-backed Seurat pipeline, checkpoint load, checkpoint fork,
  DEG marker finding, runtime check, and object inspection. The DEG marker workflow is UI-wired for
  job launch/status/safe summary metadata; the Seurat pipeline UI is wired only
  for `tenx_h5` input plus result checkpoint reattach. PBMC pipeline, runtime
  check, and object inspect worker launches remain backend-only.
- Project authorization is checked when a job is created and revalidated under a
  project lock immediately before worker claim. Queued jobs owned by a removed
  member or a member demoted below analyst are canceled with a sanitized
  `PROJECT_ACCESS_REVOKED` error before handler/R contact. A job that was already
  running keeps its valid claim and may finish; its durable output/history remains
  project-scoped, while a removed member can no longer read the project.
- There is no public artifact download surface, object storage, generated report
  export, arbitrary R execution, or shared project live R state.
- New local files survive application restarts when `STORAGE_ROOT` is persistent
  and shared correctly with the R process. Legacy records also require `VAULT_ROOT`.
  Metadata can outlive a missing file, and there is no startup reconciliation yet.
- R 4.5.x is the intended local development target; the Dockerfile pins R 4.5.3
  with Bioconductor 3.22. Report if R 4.6.x is detected.

## Testing & CI notes

- `npm run test:backend` runs the FULL backend suite (`backend/*.test.js`)
  against Postgres: config boundaries, the real `pgDatabase` contract, per-user
  isolation, auth (cookie/bearer/rate-limit/credentials), org/project RBAC,
  datasets, analysis objects, the durable job-worker claim/lease/heartbeat
  contract, artifacts/checkpoints, the lineage DAG, the R-proxy
  ownership/policy/diagnostics gates, and the mocked-R pipeline worker handlers.
  Every DB-backed suite resets the schema per test via `resetSchemaForTests()`
  and skips cleanly without `DATABASE_URL`; pure suites always run. (The SQLite-era
  schema-migration/backfill and `busy_timeout` tests were removed with the
  Postgres cutover — the Postgres schema ships every table from `pg/schema.sql`.)
  Durable jobs, artifacts/checkpoints, and lineage are implemented in the backend. The React UI now includes a
  Jobs & Artifacts / durable history surface for safe metadata visibility and
  controlled checkpoint forks, and the DEG tab launches `deg.find_markers.v1` jobs and reads
  bounded `deg_summary` metadata, and the Pipeline Manager Seurat panel launches the
  narrow `seurat.pipeline.v1` path with result checkpoint reattach. General job
  launching, artifact downloads, and lineage mutation are still not UI-wired. A
  passing backend suite means the API/DB contract holds - **not** that every
  backend feature is surfaced in the UI.
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
- The R-worker suites (`*-worker.test.js`, part of `test:backend`) **mock the R
  caller** with instant, unboxed responses, so they prove handler/bridge wiring
  but **not** real R timing, serialization, or compute. Real end-to-end completion
  of the durable Seurat pipeline against a live R backend — including worker-lease
  renewal during the long R call — is covered by `npm run test:seurat-pipeline`.
  The worker renews its claim lease from a timer while an R bridge call is in
  flight, so long compute jobs do not lose their lease mid-run; the default
  `JOB_WORKER_LEASE_SECONDS` is 120.
- The R/workflow checks (`test:seurat-pipeline`, `test:r-state-proxy`,
  `test:pbmc-parent`, `test:checkpoint-load`, `test:deg-markers`) exercise the
  hardened live paths and require a real R/Seurat backend (`test:seurat-pipeline`
  also needs `hdf5r` for 10x HDF5); they skip cleanly when R/Seurat is absent.
  `test:r-storage` separately checks project-key validation, atomic RDS writes,
  and link-escape blocking at the R storage boundary.
  CI installs `hdf5r` and runs `test:seurat-pipeline` so the UI-wired Seurat
  pipeline has a real R/worker regression gate in pull requests.
- CI runs on `pull_request` and `workflow_dispatch` only. The security-critical
  suites are additionally named explicitly in the workflow so their regression
  coverage is auditable.
