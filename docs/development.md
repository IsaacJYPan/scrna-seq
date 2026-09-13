# Development

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
Rscript -e "required <- c('plumber','jsonlite','digest','Seurat','hdf5r','ggplot2','base64enc','ComplexHeatmap','BiocGenerics','clusterProfiler','fgsea','AnnotationDbi','org.Hs.eg.db','org.Mm.eg.db','GO.db','edgeR','limma'); print(required[!vapply(required, requireNamespace, logical(1), quietly=TRUE)])"
```

An empty `character(0)` result means all required packages are installed. If
packages are missing, install the regular R packages first:

```powershell
Rscript -e "install.packages(c('plumber','jsonlite','digest','Seurat','hdf5r','ggplot2','base64enc'), repos='https://cloud.r-project.org/')"
Rscript -e "if (!requireNamespace('BiocManager', quietly=TRUE)) install.packages('BiocManager', repos='https://cloud.r-project.org/'); BiocManager::install(c('ComplexHeatmap','BiocGenerics','clusterProfiler','fgsea','AnnotationDbi','org.Hs.eg.db','org.Mm.eg.db','GO.db','edgeR','limma'), ask=FALSE)"
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
This compatibility supervisor remains one R process and does not prove the
two-slot deployment; use the Compose topology for concurrency acceptance.

When `JOB_WORKER_MIN_FREE_MEMORY_MB` is omitted, this local supervisor gives
only its worker a 256 MiB admission fallback so the development workflow can run
on constrained workstations. An explicit value is preserved. Standalone workers
and deployments retain the 1 GiB default documented in `.env.example`; this is
an admission gate, not a substitute for measured RAM capacity and real resource
limits.

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

`JOB_WORKER_CONCURRENCY` remains fixed at `1` per process. A deployment sets a
bounded `JOB_WORKER_POOL_SIZE` and a unique `JOB_WORKER_POOL_SLOT` for each
declared lane; do not point two slots at the same R process. The memory threshold
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
Compatibility-proxy mutations are explicitly unsaved. The owner may choose
**Save current analysis**, which queues parameterless `checkpoint.save.v1`, writes
the exact live object to a server-allocated private checkpoint, creates an immutable
child with lineage, and then opens that child. The save endpoint is worker-only;
the browser cannot provide a path, dataset, result ID, R code, or transformation.

Production `/api/r` is an exact reviewed method/path allowlist, not an open
Plumber catch-all. Every browser R request carries the explicit
`X-TraceOmics-CSRF: 1` first-party header; the server also accepts a reviewed
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
local loaders and live mutations, routes 10X H5 upload to Pipelines, and
keeps figure preview while disabling the legacy server-file save action.

RDS imports are disabled by default because RDS deserialization can execute R
code. Set `ALLOW_TRUSTED_RDS_LOAD=true` only for trusted local/dev `.rds` files;
production always blocks public load and restore regardless of that setting.
Approved private Expert R deployments are the exception: the picker accepts a
bounded owner-private RDS, but only a fresh no-network sandbox deserializes it.
Derived RDS output stays in the same untrusted artifact tier and never becomes a
guided-analysis checkpoint automatically.
The Docker image includes ranked-enrichment plus CellChat/NMF and CellChat's pinned
GitHub `presto`/Bioconductor `BiocNeighbors` dependencies as required runtime
dependencies; CI verifies CellChat v2.1.2. SeuratDisk remains optional
and is installed only with `--build-arg INSTALL_OPTIONAL_R_PACKAGES=true`.
The CellChat tab is a durable, owner-only single-context candidate workflow: it
uses a private capped CSV and opaque group identifiers, not a public download,
causal claim, or cross-condition comparison.

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
- `test:integration` runs the maintained Postgres/Express contract suite followed
  by the real R state-isolation check. It requires an isolated test database and
  a compatible local R runtime.

Then run the full server and database checks against `scrna_test`:

```powershell
npm run test:backend
```

Before pushing a release candidate, run the same fail-fast gates used by CI.
They must have a real test `DATABASE_URL`; CI will not start R installation,
image builds, deployment drills, or scientific certification until both pass:

```powershell
$env:DATABASE_URL = 'postgres://scrna:scrna@127.0.0.1:5432/scrna_test'
$env:NODE_ENV = 'test'
npm run check:ci-preflight
npm run check:browser-preflight
```

The preflight refuses database names that are not explicitly marked `test` or
`ci`, because the backend suites reset their target schema. Install Chromium
once with `npx playwright install chromium` before running the browser preflight.

For a deeper real-R check, download the small PBMC example data once and run the
main workflow tests. Keep `DATABASE_URL` pointed at `scrna_test`:

```powershell
node scripts/download_sample_data.js
npm run test:r-state-proxy
npm run test:seurat-pipeline
npm run test:seurat-multisample
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
is no startup file reconciliation or object storage. Byte downloads are limited
to the reviewed result allowlist and never include checkpoints or arbitrary keys.

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
npm run test:spatial-seurat
npm run test:private-compute-compose
npm run test:native-ui-compose
npm run test:expert-r-sandbox
npm run test:expert-r-browser
npm run test:demo-compose
```

For a release candidate, the manually dispatched **Release Certification**
workflow runs the expensive private-browser, Expert R, demo, multi-sample,
spatial, and Windows-installer checks as one deliberate certification event.
A dedicated self-hosted Windows runner can additionally enable the native
Electron/Compose acceptance input.
It is not triggered on ordinary pushes, avoiding repeated consumption of hosted
CI minutes while retaining a reproducible final gate.

The last five commands create randomized disposable Docker resources to prove
the isolated two-lane compute topology, a real browser plus two native Electron
profiles, the digest-pinned Expert R containment boundary and owner browser
workflow, and the distinct
website-demo lifecycle including a real Chromium scientific workflow. The native
run records only exact Electron window handles
and retains its inspected screenshots/video under
`playwright/report/release-acceptance/`. The private-compute run retains a
sanitized JSON report there as well; raw R state keys, runtime identities, and
user/project identifiers are deliberately omitted. The commands remove their
containers and volumes after completion unless an explicit acceptance-debug flag
is set.

The visual tests (`npm run test:visual`, `npm run test:visual:db-flow`) are
**mocked** frontend smoke tests — they check rendering/layout, not real
backend/R/tenant behavior, and are not integration or security evidence.
`npm run test:deployment:browser` instead drives real Chromium through the built
frontend, actual Express server, real Postgres, and a private deterministic R
test service while auditing console errors, 5xx responses, network failures,
cookie behavior, project durability, and Collaborators RBAC. See
[docs/architecture.md](architecture.md#testing--ci-notes) for what each does
and does not prove (and which runs in CI).
