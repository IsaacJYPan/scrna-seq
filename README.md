# scRNA-seq Workbench

A single-cell RNA-seq analysis workbench with a conservative single-host
deployment topology:

- React/Vite browser app.
- Express API server for auth, project/object/job metadata, uploads, and R proxying.
- Postgres for metadata/cache/provenance/job state
  (`backend/pgDatabase.js` + `backend/pg/schema.sql`).
- R Plumber/Seurat backend for computation.

The repository now includes a supported deployment candidate for one Linux host:
fail-fast production configuration, cookie-only versioned sessions, health and
graceful drain, non-root/read-only Compose services, a private R/Postgres network
namespace, resource limits, and verified offline backup/restore. This is not a
high-availability, hostile-user multi-tenant, or hostile-code-compute platform.
Data is sensitive by default: project-scoped production APIs expose no public
downloads, shared live R state, or raw storage paths/keys. Production account
creation is operator-only and legacy vault uploads are disabled. Read
[docs/deployment.md](docs/deployment.md) before exposing it.

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
  durable `deg.find_markers.v1` jobs, ranked GO Biological Process enrichment
  through durable `enrichment.gsea.v1` jobs, and bounded summary artifacts, the narrow
  10x HDF5 `seurat.pipeline.v1` Pipeline Manager flow with result checkpoint
  reattach, project member/role management, private collaborator checkpoint
  forks with durable source lineage, a trusted global declarative pipeline
  registry for code-shipped modules, provenance/figures/cache.
- **Backend implemented with selected UI actions and read-only metadata:** durable jobs,
  artifacts/checkpoints, and lineage exist in the backend, and the React UI now
  includes a Jobs & Artifacts / durable history surface for safe metadata plus
  controlled checkpoint forks. DEG and pathway-enrichment launches are wired in their
  result tabs, and the Pipeline
  Manager Seurat panel can launch the supported 10x HDF5 pipeline plus checkpoint
  reattach. Artifact downloads, general job launch/cancel/retry, and lineage
  mutation are still not UI-wired.
- **Backend-only (implemented + tested, no UI yet):** general dataset management,
  standalone worker operations/health controls, and
  the PBMC pipeline / runtime-check / object-inspect worker workflows. The DEG,
  ranked pathway-enrichment, and narrow Seurat pipeline workers are UI-wired for selected
  launch/status/safe summary metadata only.
- **Infrastructure foundation (supported single-host shape):** cookie-only
  HttpOnly sessions with database-backed revoke-all versioning and a deployment
  epoch, operator-audited account provisioning/password reset, an expanded
  Postgres runtime data layer, server-owned storage keys, fail-fast production
  config, liveness/readiness and graceful drain, a singleton web topology fence,
  a standalone Postgres-lease queue consumer, hardened container packaging, and
  offline manifest-verified backup/restore that invalidates pre-restore sessions
  and cancels restored active jobs.
- **Durable local storage:** new dataset, checkpoint, DEG, and pathway-enrichment files use
  server-owned project keys under `STORAGE_ROOT`. Existing private-vault records
  remain readable. Project writers can fork a member's durable checkpoint into a
  new object that they own from Jobs & Artifacts, without sharing live R state;
  the fork records its source object, checkpoint, job, and lineage edge.
- **Not implemented (product):** CellChat, cell annotation,
  custom/arbitrary R execution, reports, generated scripts, artifact downloads,
  object storage, shared project live R state, high availability, and parallel R
  worker scaling.

See **[docs/architecture.md](docs/architecture.md)** for the full
implemented-vs-UI-wired table, the DEG dual-path detail, the
hidden-feature-vs-reachable-endpoint policy, the RDS trusted-input boundary, and
the testing/CI notes. [docs/deployment.md](docs/deployment.md) defines the exact
operating, security, backup, restore, and recovery boundaries. Keep both honest
when behavior changes.

## Trusted Pipeline Registry

Pipeline manifests are global, declarative definitions for composing UI modules
that already ship with the application. Any project member may list approved
manifests and select one for their own user/project pair. Project roles do not
grant publication rights: only an account with the server-managed
`pipeline_registry.publish` platform capability sees and may use the publication
UI.

An operator grants, revokes, or inspects that capability outside the browser:

```bash
npm run platform-developer -- grant developer@example.com
npm run platform-developer -- status developer@example.com
npm run platform-developer -- revoke developer@example.com
```

Publication accepts at most 64 KiB of strictly validated JSON and the registry
is capped at 200 definitions. Backend and frontend consume the same
data-only module contract. The Pipeline Manager can render declared parameter
and result templates as a disabled, read-only preview; the preview never submits
parameters or starts work. Routes, React components, artifact types, and worker
job types remain application-controlled. Of the manifest modules currently
registered, the durable DEG and ranked pathway-enrichment modules declare executable
job types `deg.find_markers.v1` and `enrichment.gsea.v1`.

Definitions created by the older project/user upload path remain stored but are
quarantined: they are neither listed nor selectable as trusted definitions, and
an existing selection that references one safely falls back to the built-in
pipeline. Stored platform definitions are revalidated before being returned.

Manifest publication does not upload JavaScript, R code, R packages, endpoints,
or new module implementations, and it is not a generic execution engine. Future
BYOC arbitrary-R support would require isolated per-job containers or VMs,
strict input/output mounts, network and secret isolation, and resource quotas.

## Ranked Pathway Enrichment

The Pathway Enrichment tab now launches `enrichment.gsea.v1` for one selected
cluster or identity group versus the remaining cells. It ranks every gene that
can be tested by the fixed Wilcoxon comparison, maps gene symbols through an
explicit human or mouse annotation database, and runs local Gene Ontology
Biological Process GSEA. The user cannot supply R code, package names, endpoints,
or file paths.

The job is project-scoped, queued, owner-verified before R contact, protected by
the same lease and signed completion-receipt recovery used by other durable R
jobs, and publishes exactly two artifacts: a private internal CSV table and a
small metadata-only preview for the UI. There is no public download route. The
signed result records the R, Seurat, pathway-analysis, annotation, and organism-
database versions used, so later software changes do not erase its provenance.
UI describes the result as an association, not proof that a pathway is active;
condition-level claims still require biological-sample metadata and a
sample-aware comparison. Species is required rather than guessed. Large
comparisons use a visible, repeatable per-group cell limit (10,000 by default)
so one request cannot silently expand to every cell in a very large object.

The production R image makes `clusterProfiler`, `fgsea`, `AnnotationDbi`, both
human and mouse organism databases, and `GO.db` mandatory. The R 4.5.3 image
and real-R enrichment smoke pass on this worktree. A release still needs the
normal deployed database, worker, and browser acceptance checks.

## Running Locally

The local app has four parts:

- the browser screen, built with Node.js;
- the Express server, which handles accounts, projects, and permissions;
- PostgreSQL, which stores accounts, projects, jobs, and history;
- R and Seurat, which perform the scientific calculations.

`npm run dev` starts everything except PostgreSQL. The simplest local setup is
to run PostgreSQL in Docker and use R installed on your computer.

### What to install first

- Node.js 22.15 or newer, but lower than Node 25;
- Docker Desktop, with its Linux container engine running;
- R 4.5.3 is recommended, available as `Rscript` in your terminal.

The production Docker image uses R 4.5.3. Other R versions may work for local
experiments, but they are not the version used for the release image.

If Windows has more than one R version, you can choose the one the app should
use before running `npm run dev`:

```powershell
$env:RSCRIPT_PATH = 'C:\Program Files\R\R-4.5.3\bin\Rscript.exe'
```

### Quick start on Windows PowerShell

Run these commands from the repository folder:

```powershell
# Install the exact Node packages recorded in package-lock.json.
npm ci

# Start only the local PostgreSQL database.
docker compose up -d postgres

# Tell Node where that database is, then create/update its tables.
$env:DATABASE_URL = 'postgres://scrna:scrna@127.0.0.1:5432/scrna'
npm run init:postgres

# Start the browser app, Express server, R service, and job worker.
npm run dev
```

Open <http://localhost:5173> in your browser. In development mode you can create
a test account from the login screen. Keep the PowerShell window open while you
use the app. Press `Ctrl+C` once when you want to stop the app.

PostgreSQL continues running in Docker after the app stops. Stop it with:

```powershell
docker compose stop postgres
```

That command keeps your local database files. `docker compose down -v` would
delete the database volume, so do not add `-v` unless you intentionally want to
erase the local database.

### Check the local R installation

This command lists any required R packages that are missing:

```powershell
Rscript -e "required <- c('plumber','jsonlite','digest','Seurat','hdf5r','ggplot2','base64enc','ComplexHeatmap','BiocGenerics','clusterProfiler','fgsea','AnnotationDbi','org.Hs.eg.db','org.Mm.eg.db','GO.db'); print(required[!vapply(required, requireNamespace, logical(1), quietly=TRUE)])"
```

An empty `character(0)` result means all required packages are installed. If
packages are missing, install the regular R packages first:

```powershell
Rscript -e "install.packages(c('plumber','jsonlite','digest','Seurat','hdf5r','ggplot2','base64enc'), repos='https://cloud.r-project.org/')"
Rscript -e "if (!requireNamespace('BiocManager', quietly=TRUE)) install.packages('BiocManager', repos='https://cloud.r-project.org/'); BiocManager::install(c('ComplexHeatmap','BiocGenerics','clusterProfiler','fgsea','AnnotationDbi','org.Hs.eg.db','org.Mm.eg.db','GO.db'), ask=FALSE)"
```

These installs can take a while because Seurat has many supporting packages.

### macOS or Linux shell

The same setup works in a Bash-style shell; only the environment-variable syntax
changes:

```bash
npm ci
docker compose up -d postgres
export DATABASE_URL=postgres://scrna:scrna@127.0.0.1:5432/scrna
npm run init:postgres
npm run dev
```

The development supervisor gives Express and the worker a temporary private key
so both can talk to the same local R process. `npm run dev:no-worker` omits the
background job worker; use the full `npm run dev` command when testing the
durable Seurat and differential-expression workflows.

### Advanced local runtime details

You can skip this section for the normal quick-start setup above.

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
Plumber catch-all. Every browser R request carries the explicit
`X-BenchOne-CSRF: 1` first-party header; the server also accepts a reviewed
Origin/Referer fallback. This applies even to GET because legacy GET operations
can mutate private live R state. The compatibility proxy has one global admission slot plus
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
The frontend consumes a fail-closed deployment policy: production hides those
local loaders and live mutations, routes 10X H5 upload to Pipeline Manager, and
keeps figure preview while disabling the legacy server-file save action.

RDS imports are disabled by default because RDS deserialization can execute R
code. Set `ALLOW_TRUSTED_RDS_LOAD=true` only for trusted local/dev `.rds` files;
production always blocks public load and restore regardless of that setting.
The Docker image includes the ranked-enrichment packages as required runtime
dependencies. It still skips optional legacy packages such as CellChat and
SeuratDisk unless built with `--build-arg INSTALL_OPTIONAL_R_PACKAGES=true`.

### Testing without erasing your development data

The backend tests repeatedly empty and rebuild their database tables. Never point
them at a database containing work you want to keep. Create a separate test
database once:

```powershell
docker compose up -d postgres
docker compose exec postgres createdb -U scrna scrna_test
$env:DATABASE_URL = 'postgres://scrna:scrna@127.0.0.1:5432/scrna_test'
```

If `createdb` says `scrna_test` already exists, you can continue. Start with the
short checks:

```powershell
npm run lint
npm run build
npm run test:frontend
npm run test:unit
```

What these mean:

- `lint` looks for suspicious JavaScript and React patterns;
- `build` proves the browser app can be packaged;
- `test:frontend` checks the browser-screen logic with simulated API replies;
- `test:unit` runs the local R/Seurat calculation checks.

Then run the full server and database checks against `scrna_test`:

```powershell
npm run test:backend
```

For a deeper real-R check, download the small PBMC example data once and run the
main workflow tests. Keep `DATABASE_URL` pointed at `scrna_test`:

```powershell
node scripts/download_sample_data.js
npm run test:r-state-proxy
npm run test:seurat-pipeline
npm run test:deg-worker-pipeline
```

These deeper checks start real local services and can take several minutes.

Before starting the normal app again, point `DATABASE_URL` back to the development
database:

```powershell
$env:DATABASE_URL = 'postgres://scrna:scrna@127.0.0.1:5432/scrna'
npm run dev
```

### PostgreSQL details

Postgres is required for the app runtime. To develop or test locally:

```bash
docker compose up -d postgres      # localhost-only Postgres (or use any local PG)
export DATABASE_URL=postgres://scrna:scrna@localhost:5432/scrna
npm run init:postgres              # apply backend/pg/schema.sql (idempotent)
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
backend/R/tenant behavior, and are not integration or security evidence.
`npm run test:deployment:browser` instead drives real Chromium through the built
frontend, actual Express server, real Postgres, and a private deterministic R
test service while auditing console errors, 5xx responses, network failures,
cookie behavior, project durability, and Collaborators RBAC. See
[docs/architecture.md](docs/architecture.md#testing--ci-notes) for what each does
and does not prove (and which runs in CI).

