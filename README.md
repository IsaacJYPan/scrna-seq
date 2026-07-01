# scRNA-seq Workbench

A local/development-oriented single-cell RNA-seq analysis workbench:

- React/Vite browser app.
- Express API server for auth, project/object/job metadata, uploads, and R proxying.
- SQLite for local metadata/cache/provenance/job state.
- R Plumber/Seurat backend for computation.

This repository is not a production-complete multi-tenant service. Treat it as a
local or trusted-environment workbench while the production boundaries are still
being hardened.

## Runtime Shape

```text
Browser (React/Vite)
  -> Express API (auth, authorization, DB, uploads, R proxy)
  -> R Plumber/Seurat backend (compute only, localhost/private)
```

Express is the authentication and authorization boundary. The R backend trusts
only server-injected headers such as `X-API-Token` and server-derived
`X-Object-ID`; it must not be exposed directly to users or the public network.

## Architecture Status: Implemented vs UI-wired

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
| Auth / logout | UI-wired | localStorage bearer token; no secure cookies / server-side revocation yet. |
| Organizations / projects | UI-wired | A personal org/project is auto-created for the live-load flow. |
| Project members / RBAC endpoints | backend-only | Role-checked member APIs exist and are tested. The in-app "Collaborators" panel is a local/in-memory shell and is **not** wired to these endpoints. |
| Project-scoped datasets | backend-only | Upload with server-chosen storage key + sha256; no UI dataset manager. |
| DB-backed analysis objects (`ao_*`) | UI-wired | Created/selected via the workspace; authoritative object identity. |
| Live R object state | UI-wired | Private, transient, keyed by server-derived user/object state. |
| QC / Normalize / PCA / Cluster / UMAP / plots | UI-wired | Run through the authenticated live-R proxy (`/api/r/*`). |
| DEG (differential expression) | UI-wired (legacy path) | UI calls the legacy live-R endpoint `/api/r/deg`. See "DEG paths" below. |
| Durable DEG worker (`deg.find_markers.v1`) | backend-only | Durable, allowlisted worker job + `r.deg.find_markers.v1` bridge op. Not wired into the UI. |
| Durable jobs | backend-only | Durable ownership-scoped job records + API; no UI job manager. |
| Job worker loop | backend-only (opt-in) | Off unless `ENABLE_JOB_WORKER="true"`; drains only registered, allowlisted handlers. |
| PBMC pipeline worker (`pbmc.pipeline.v1`) | backend-only | Copy-on-modify Seurat preprocessing as a durable job; not wired into the UI. |
| Checkpoint artifacts | backend-only | Immutable result checkpoint metadata per successful job. |
| Checkpoint load worker (`checkpoint.load.v1`) | backend-only | Owner-only reattach of a server-selected checkpoint into live R; not wired into the UI. |
| Job artifacts (metadata) | backend-only | Read-only, path/storage-key stripped from responses; no download route. |
| Analysis-object lineage DAG | backend-only | Edge model + parents/children/lineage read routes; no lineage-DAG UI. |
| Provenance / figures / cache | UI-wired | Through the older `/api/db/*` routes. |
| Runtime check / object inspect workers | backend-only | Read-only, metadata-only bridge operations. |
| Pathway enrichment | not implemented (product) | No durable workflow. A legacy authenticated R endpoint may still exist (see below). |
| CellChat / cell-cell communication | not implemented (product) | No durable workflow. Legacy authenticated R endpoints may still exist (see below). |
| Cell annotation | not implemented (product) | UI placeholder only. A legacy authenticated R endpoint may still exist (see below). |
| Custom Script / arbitrary R execution | not implemented | Out of scope; no arbitrary-R endpoint. |
| Reports / generated R scripts | not implemented | No report or script-export surface. |
| Artifact downloads | not implemented | No public download route; responses never expose storage paths/keys. |
| Object storage | not implemented | Local vault only; no external object storage. |
| Secure cookie sessions | not implemented | Browser auth is still localStorage bearer tokens. |
| Shared project live R state | not implemented | Collaboration is via durable metadata, never a shared live R session. |

### DEG paths (two implementations)

There are currently two DEG implementations, and only one is wired into the app:

- **UI today:** the React DEG page calls the **legacy live-R path**
  `/api/r/deg` through the authenticated proxy. This runs synchronously against
  the caller's private live object.
- **Backend-only:** a **durable, worker-backed** DEG implementation
  (`deg.find_markers.v1` job + `r.deg.find_markers.v1` bridge operation) exists
  and is tested, but is **not** wired into the UI.

Neither path is removed. This branch does not migrate the UI to the worker.

### Hidden/disabled features vs reachable R endpoints

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
worker bridge. The current policy is pinned by
`backend/r-proxy-policy.test.js`.

### RDS loading is a trusted-input boundary

The R backend can load `.rds` objects (e.g. via `/api/r/load-rds`). **RDS
deserialization can execute arbitrary R code.** The route is owner-scoped and
path-validated (confined to the per-user vault), but imported RDS files should
be treated as **trusted/local-dev input** until stronger sandbox/container
isolation exists. Do not load untrusted `.rds` files.

## Running Locally

```bash
npm install
npm run dev
```

This starts Vite plus the Express server, which starts local R Plumber in the
current development setup. A local R installation with the required Seurat
packages is expected.

Fast checks (no R backend required):

```bash
npm run lint
npm run build
npm run test:backend
npm run test:frontend
```

R/workflow checks for the hardened, live paths (require a real R/Seurat backend;
they skip cleanly when Seurat is unavailable):

```bash
npm run test:r-state-proxy
npm run test:pbmc-parent
npm run test:checkpoint-load
npm run test:deg-markers
```

### Frontend visual smoke tests (mocked — not integration)

The visual tests render the built UI with the backend and R responses **mocked**
in the browser. They check rendering/layout and obvious UI regressions. They do
**not** verify real backend, R, project, object, job, artifact, or tenant
behavior, and should not be cited as integration or security evidence.

```bash
npm run test:visual         # mocked frontend visual smoke test (runs in CI)
npm run test:visual:db-flow  # mocked UI model of the DB-backed object flow
```

`npm run test:visual:db-flow` drives the DB-backed project/object UI flow with
**all `/api/*` responses mocked** via Playwright route interception and a fake
auth token. It requires a browser (Playwright/Chromium) + Vite, is **not run in
CI**, and is best used as a **local pre-merge smoke test** for branches that
change the project/object UI flow. It proves the UI *model* wiring (what the app
requests and how it renders responses); it does **not** prove real backend,
auth, ownership, or tenant isolation.

## Testing & CI notes

- `npm run test:backend` runs the full `backend/*.test.js` suite. These are
  **backend contract tests**: they exercise the real Express + SQLite stack,
  including subsystems that are **backend-only** (jobs, worker coordination,
  artifacts/checkpoints, lineage DAG, datasets, RBAC). A passing backend suite
  means the API/DB contract holds — **not** that a feature is surfaced in the UI.
- CI runs on `pull_request` and `workflow_dispatch` only. The security-critical
  suites are additionally named explicitly in the workflow so their regression
  coverage is auditable.

## Current Boundaries

- Browser auth is still localStorage bearer-token based; secure cookie sessions
  and server-side token revocation are not implemented.
- Backend projects, DB-backed analysis objects, jobs, artifacts, checkpoints,
  and lineage are the durable source of truth **at the API/DB layer**. Of these,
  projects and analysis objects are UI-wired; jobs, artifacts, checkpoints,
  lineage, datasets, and RBAC management are backend-only (see the status table).
- localStorage may cache selected project/object IDs and UI preferences only; it
  is not authoritative for projects, analysis objects, lineage, jobs, roles, or
  checkpoints.
- Live R state is private, transient, and keyed by server-derived user/object
  state. Project metadata visibility does not grant live R access.
- The worker is opt-in and allowlisted. Registered handlers include PBMC
  pipeline, checkpoint load, DEG marker finding, runtime check, and object
  inspection. None of these worker workflows are wired into the UI yet.
- Pathway enrichment and CellChat are not production-integrated worker
  workflows; legacy authenticated R endpoints may still be reachable (see
  "Hidden/disabled features vs reachable R endpoints").
- There is no public artifact download surface, object storage, generated report
  export, arbitrary R execution, or shared project live R state.
- R 4.5.x is the intended local development target; report if R 4.6.x is
  detected.

## Documentation Policy

Tracked markdown is intentionally limited to this README. Development notes,
agent workflow rules, design/spec material, and current-state handoff context
belong in local ignored markdown under `.project/codex/`.

If behavior, tests, security boundaries, or workflow expectations change, update
this README (and the relevant local docs in `.project/codex/`) at the same time
as the code. In particular, keep the "Implemented vs UI-wired" status table
honest when a subsystem moves between backend-only and UI-wired.
