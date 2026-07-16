# scRNA-seq Workbench

A local/development-oriented single-cell RNA-seq analysis workbench:

- React/Vite browser app.
- Express API server for auth, project/object/job metadata, uploads, and R proxying.
- Postgres for metadata/cache/provenance/job state
  (`backend/pgDatabase.js` + `backend/pg/schema.sql`).
- R Plumber/Seurat backend for computation.

This repository is not a production-complete multi-tenant service. Treat it as a
local or trusted-environment workbench while the production boundaries are still
being hardened. Infrastructure is moving toward a hosted-service-ready shape:
Postgres, HttpOnly cookie sessions over localStorage bearer tokens,
and centralized environment/config validation (`backend/config.js`). Data is
sensitive by default — no public downloads, no shared live R state, and no raw
storage paths/keys in responses.

## Runtime Shape

```text
Browser (React/Vite)
  -> Express API (auth, authorization, DB, uploads, R proxy) --+
                                                               +-> private R Plumber/Seurat service
Standalone job worker -> Postgres queue + shared storage ------+
```

Express is the authentication and authorization boundary. The R backend trusts
only server-injected headers such as `X-API-Token` and server-derived
`X-Object-ID`; it must not be exposed directly to users or the public network.
The supported v1 execution topology is deliberately limited to one standalone
worker process, one in-flight job, and the same private R service used by the web
proxy. This preserves private live-R object continuity while moving durable work
out of the web process. Multiple heavy R workers are not yet a supported scaling
topology.

## Architecture Status

The backend has moved ahead of the React UI: several subsystems are implemented
and tested at the API/DB layer but are **not yet surfaced in the app**. Do not
assume "implemented and tested" means "usable in the UI".

At a glance:

- **UI-wired:** auth, organizations/projects, DB-backed analysis objects
  (`ao_*`), live R object state, QC/Normalize/PCA/Cluster/UMAP/plots, DEG through
  durable `deg.find_markers.v1` jobs and bounded summary artifacts, the narrow
  10x HDF5 `seurat.pipeline.v1` Pipeline Manager flow with result checkpoint
  reattach, project member/role management, private collaborator checkpoint
  forks with durable source lineage, declarative pipeline manifests for registered modules,
  provenance/figures/cache.
- **Backend implemented with selected UI actions and read-only metadata:** durable jobs,
  artifacts/checkpoints, and lineage exist in the backend, and the React UI now
  includes a Jobs & Artifacts / durable history surface for safe metadata plus
  controlled checkpoint forks. DEG job launch is wired in the DEG tab, and the Pipeline
  Manager Seurat panel can launch the supported 10x HDF5 pipeline plus checkpoint
  reattach. Artifact downloads, general job launch/cancel/retry, and lineage
  mutation are still not UI-wired.
- **Backend-only (implemented + tested, no UI yet):** general dataset management,
  standalone worker operations/health controls, and
  the PBMC pipeline / runtime-check / object-inspect worker workflows. The DEG
  marker worker and narrow Seurat pipeline worker are UI-wired for selected
  launch/status/safe summary metadata only.
- **Infrastructure foundation (backend-wired, hosted-service direction):**
  HttpOnly cookie sessions (login/signup set the cookie; `/api/auth/session`
  restores; `/api/auth/logout` clears; cookie auth is preferred while the
  localStorage bearer remains a deprecated fallback), an expanded Postgres data
  runtime data layer + schema proven by real-Postgres contract/runtime tests,
  server-owned storage-key hardening, centralized config validation, and a
  standalone Postgres-lease queue consumer with crash recovery and graceful
  drain behavior.
- **Durable local storage:** new dataset, checkpoint, and DEG files use
  server-owned project keys under `STORAGE_ROOT`. Existing private-vault records
  remain readable. Project writers can fork a member's durable checkpoint into a
  new object that they own from Jobs & Artifacts, without sharing live R state;
  the fork records its source object, checkpoint, job, and lineage edge.
- **Not implemented (product):** pathway enrichment, CellChat, cell annotation,
  custom/arbitrary R execution, reports, generated scripts, artifact downloads,
  object storage, server-side session revocation, shared project live R state.

See **[docs/architecture.md](docs/architecture.md)** for the full
implemented-vs-UI-wired table, the DEG dual-path detail, the
hidden-feature-vs-reachable-endpoint policy, the RDS trusted-input boundary, and
the testing/CI notes. Keep that table honest when a subsystem moves between
backend-only and UI-wired.

## Running Locally

```bash
npm install
npm run dev
```

This starts Vite, Express, one local R Plumber service, and one standalone job
worker. The development supervisor gives Express and the worker one ephemeral R
service token so both reach the same private live-R process. Use
`npm run dev:no-worker` when only Vite, Express, and local R are needed.

A local R installation with the required Seurat packages is expected. The
local/dev R target is the R 4.5.x family; the Docker image pins R 4.5.3 with
Bioconductor 3.22.

For a separately managed R service, configure `R_RUNTIME_MODE=external`, a
private `R_BACKEND_URL`, and the same dedicated 32-or-more-character
`R_API_TOKEN` on Express, the standalone worker, and R (as `API_TOKEN`). Then
run the processes separately:

```bash
npm run start
npm run worker
```

The worker also requires the same Postgres database and the same persistent
`STORAGE_ROOT` mount as Express and R. Its private `/livez` and `/readyz`
endpoints default to `127.0.0.1:3101`. Readiness requires Postgres,
authenticated R, a shared-storage proof, and the configured free-memory
admission threshold before any claim is taken.

`JOB_WORKER_CONCURRENCY` is fixed at `1` in this topology. The memory threshold
pauses new claims but is not a hard RAM limit; deployments still need real
container/VM resource limits. Cancellation is cooperative for shared-R calls:
it blocks durable output publication, but it does not claim to terminate compute
already running inside R. See `.env.example` for lease, capability, health, and
drain settings.

Private live-R objects are bounded independently of job admission. R accepts only
authenticated server-derived state keys, retains no empty keys, and applies
deterministic least-recently-used eviction against global/per-user session-count
and estimated object-byte budgets. Evicted objects must be reattached from their
durable checkpoint; collaborators never share another user's live R object.

Production `/api/r` is an exact reviewed method/path allowlist, not an open
Plumber catch-all. Cookie-authenticated R requests require an allowed
Origin/Referer even for GET because legacy GET operations can mutate private
live R state. The compatibility proxy has one global admission slot plus
rate/deadline/request/response limits, accepts only bodyless GET or bounded JSON
POST requests, strips all browser headers before injecting only the private R
token/state key, requires JSON success responses, replaces every upstream error
  with a stable public body, strips private path/runtime fields, and blocks legacy
  heavy, RDS, persistent-export, synchronous vault-loading, unbounded metadata-import,
  and unmanaged live-subset routes in production.
Uploaded 10X/H5 work should use the reviewed project dataset + durable Seurat job
path; the legacy live-session loaders, CSV inspection/mutation, and vault-writing subset
flow remain local/development compatibility only until they have bounded durable jobs.
Synchronous batch integration is also development-only: CCA anchor search scales
across batch pairs and cannot be safely interrupted when the shared R service times out.

RDS imports are disabled by default because RDS deserialization can execute R
code. Set `ALLOW_TRUSTED_RDS_LOAD=true` only for trusted local/dev `.rds` files;
production always blocks public load and restore regardless of that setting.
The Docker image skips optional legacy packages such as CellChat and SeuratDisk
unless built with `--build-arg INSTALL_OPTIONAL_R_PACKAGES=true`.

Fast checks (no R backend required):

```bash
npm run lint
npm run build
npm run test:backend    # full Postgres backend suite (DB-backed suites skip without DATABASE_URL)
npm run test:frontend
```

### Postgres Database

Postgres is required for the app runtime. To develop or test locally:

```bash
docker compose up -d postgres      # localhost-only Postgres (or use any local PG)
export DATABASE_URL=postgres://scrna:scrna@localhost:5432/scrna
npm run init:postgres              # apply backend/pg/schema.sql (idempotent)
npm run test:backend:postgres      # full real-Postgres backend suite (backend/*.test.js)
```

`test:backend` runs every `backend/*.test.js`. DB-backed suites (auth, RBAC,
datasets, analysis objects, the job-worker contract, artifacts/checkpoints,
lineage, the R-proxy gates, and the mocked-R pipeline handlers) each reset the
schema per test via `resetSchemaForTests()` and skip cleanly when
`DATABASE_URL`/`PG*` is not set; suites with no DB dependency (pure validators,
serializers, config) always run. The server itself requires Postgres before it
starts. Configuration is read and
validated in `backend/config.js`; see `.env.example` for cookie, storage-root,
and upload-limit requirements.
Existing local SQLite data is not migrated; a fresh Postgres database starts empty.

Postgres metadata and scientific files are durable when both Postgres and
`STORAGE_ROOT` are persisted and shared with Express, the worker, and R. Existing
private-vault records also require `VAULT_ROOT` while they remain in use. Heavy
jobs have bounded retry support: exact already-committed outputs can be resumed
after a worker crash without another R call, including output committed on the
final execution attempt or before creator removal. Partial or ambiguous output
sets fail closed, and a canceled job cannot retain published output. There
is no startup file reconciliation, object storage, or byte-download API yet.

R/workflow checks for the hardened, live paths (require a real R/Seurat backend;
they skip cleanly when Seurat is unavailable):

```bash
npm run test:r-storage
npm run test:r-public-bounds
npm run test:r-state-proxy
npm run test:seurat-pipeline
npm run test:pbmc-parent
npm run test:checkpoint-load
npm run test:deg-markers
```

The visual tests (`npm run test:visual`, `npm run test:visual:db-flow`) are
**mocked** frontend smoke tests — they check rendering/layout, not real
backend/R/tenant behavior, and are not integration or security evidence. See
[docs/architecture.md](docs/architecture.md#testing--ci-notes) for what each does
and does not prove (and which runs in CI).

## Documentation Policy

Tracked markdown is limited to this `README.md` plus the curated `docs/` tree
(for example [docs/architecture.md](docs/architecture.md)). Development notes,
agent workflow rules, design/spec material, and current-state handoff context
belong in local ignored markdown under `.project/codex/`.

If behavior, tests, security boundaries, or workflow expectations change, update
`README.md` and the relevant `docs/` file (and any local `.project/codex/` notes)
in the same change as the code.
