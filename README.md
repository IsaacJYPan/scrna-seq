# TraceOmics

A collaborative, provenance-first transcriptomic analysis platform with a
conservative single-host deployment topology:

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
downloads, shared live R state, or raw storage paths/keys. An exact set of private
result downloads is authenticated, visibility-checked, checksum-verified, and
audited. Production account
creation is operator-only and legacy vault uploads are disabled. The
[deployment guide](docs/deployment.md) begins with a non-technical public-demo
checklist; the detailed operator runbook follows it.

New credentials require at least 15 Unicode characters, reject a small set of
common/repetitive/account-derived values, and allow long passphrases without a
symbol or capitalization rule. Existing credentials remain login-compatible.
Authenticated users can change their password from Account security; the change
rotates the account session generation, preserves the requesting browser with a
fresh cookie, revokes other sessions, and records an append-only security event.
Email verification and network password recovery are intentionally not provided;
production accounts and recovery remain operator-managed.

The supported private-deployment model is self-hosted/BYOC-style: the lab or
customer operates the web app, Postgres, durable storage, workers, and R services
on infrastructure it controls. The repository does not provide a managed SaaS
control plane, automatic multi-host scaling, or an institutional security
approval. Release certification and the deployment guide's host-specific backup,
monitoring, TLS, and restore checks still apply to every installation.

## Runtime Shape

```text
Browser -> Express -> private interactive R service
Checkpoint attach/fork worker -> interactive R service
Postgres queue + shared storage
  -> compute worker 1 -> private R runtime 1
  -> compute worker 2 -> private R runtime 2
```

Express is the authentication and authorization boundary. The R backend trusts
only server-injected headers such as `X-API-Token` and server-derived
`X-Object-ID`; it must not be exposed directly to users or the public network.
The single-host deployment keeps interactive live-R continuity on its existing
private service and adds two single-flight compute workers, each connected to a
different private R process. Heavy checkpoint-backed jobs hydrate an immutable,
server-selected checkpoint into a job-scoped state key before analysis. This
supports two concurrent heavy jobs without shared mutable R state. The R route
erases that hydrated key before returning (including after handled failure or a
response-side timeout), so a later user never inherits residual expression state
when a compute process is reused.

## Windows desktop installer

For local installer acceptance without a signing certificate:

```powershell
npm ci
npm run desktop:dist:unsigned
```

The installer is written as
`release/desktop/TraceOmics-Setup-<version>-x64.exe`. The installed TraceOmics
app is a hardened Electron shell that connects to a configured HTTPS TraceOmics
server and keeps the same server-side authentication, RBAC, Postgres, storage,
and R-compute boundaries. It does not embed Postgres, Docker, or the R workers.
Set `TRACEOMICS_DESKTOP_URL` during a managed build to make first launch
preconfigured, or let the user enter the server address. The app verifies a
compatible server response before saving that address.

`npm run desktop:dist` is the release command and requires Windows code-signing
credentials. The manual Release Certification workflow builds the signed NSIS
installer, verifies its publisher and product metadata, emits a SHA-256 sidecar,
and uploads the artifacts. Automatic in-app updates are not configured; updates
are distributed as replacement signed installers.

## Architecture Status

The backend has moved ahead of the React UI: several subsystems are implemented
and tested at the API/DB layer but are **not yet surfaced in the app**. Do not
assume "implemented and tested" means "usable in the UI".

At a glance:

- **UI-wired:** auth, organizations/projects, DB-backed analysis objects
  (`ao_*`), live R object state, QC/Normalize/PCA/Cluster/UMAP/plots, DEG through
  durable `deg.find_markers.v1` jobs, ranked GO Biological Process enrichment
  through durable `enrichment.gsea.v1` jobs, bounded `explore.summarize.v1`
  exploratory recipes, replicate-aware `condition.pseudobulk_de.v1` edgeR
  comparisons over explicit biological samples and immutable contrast snapshots,
  and summary artifacts, the single-dataset 10x HDF5 `seurat.pipeline.v1` flow,
  the multi-sample/multi-condition 10x HDF5 `seurat.multisample.v1` preparation flow, and
  classic Space Ranger Visium ZIP `spatial.seurat.v1` flow in Approved workflows,
  explicit saving of modified private live analyses, result saved-version reattach,
  project member/role management, private collaborator checkpoint
  forks with durable source lineage, a trusted global declarative pipeline
  registry for code-shipped modules, provenance/figures/cache.
- **Backend implemented with selected UI actions and read-only metadata:** durable jobs,
  artifacts/checkpoints, and lineage exist in the backend, and the React UI now
  includes a Runs & Results / durable history surface for safe metadata plus
  controlled checkpoint forks. DEG, ranked pathway-enrichment, and narrow
  single-context CellChat launches are wired in their result tabs, and the Pipeline
  Approved workflows Seurat panel can launch the supported single- or multi-sample 10x HDF5 pipeline plus saved-version
  reattach. Selected result-table/Expert-R downloads and reproducibility-manifest
  exports are UI-wired; general job launch/cancel/retry and lineage mutation are not.
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
- **Durable local storage:** new dataset, checkpoint, DEG, pathway-enrichment, and
  CellChat candidate-table files use server-owned project keys under `STORAGE_ROOT`.
  Existing private-vault records
  remain readable. Owners can explicitly snapshot current private live state into
  a new immutable saved analysis; project writers can fork a member's durable checkpoint into a
  new analysis that they own from Runs & Results, without sharing live R state;
  the fork records its source object, checkpoint, job, and lineage edge.
- **Not implemented (product):** cross-condition CellChat, cell annotation,
  rendered publication reports, generated standalone R scripts,
  object storage, shared project live R state, high availability, and elastic or
  multi-host R worker scaling.

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
`pipeline_registry.publish` platform capability may publish. Manifest publication
and platform-capability administration are deliberately outside the ordinary
researcher browser interface.

An operator grants, revokes, or inspects that capability outside the browser:

```bash
npm run platform-developer -- grant developer@example.com
npm run platform-developer -- status developer@example.com
npm run platform-developer -- revoke developer@example.com
```

Publication accepts at most 64 KiB of strictly validated JSON and the registry
is capped at 200 definitions. Backend and frontend consume the same
data-only module contract. Approved workflows can render declared parameter
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
small metadata-only preview for the UI. Its complete CSV is available only through
the authenticated, audited result-download route. The
signed result records the R, Seurat, pathway-analysis, annotation, and organism-
database versions used, so later software changes do not erase its provenance.
UI describes the result as an association, not proof that a pathway is active;
condition-level claims still require biological-sample metadata and a
sample-aware comparison. Species is required rather than guessed. Large
comparisons use a visible, repeatable per-group cell limit (10,000 by default)
so one request cannot silently expand to every cell in a very large object.

The production R image makes `clusterProfiler`, `fgsea`, `AnnotationDbi`, edgeR,
limma, both human and mouse organism databases, and `GO.db` mandatory. The R 4.5.3 image
and real-R enrichment smoke pass on this worktree. Disposable deployment checks
cover the real database, workers, browser, and native shell; any announced public
demo must additionally pass the browser workflow through its final HTTPS host.

Expert R is an opt-in private-deployment feature, disabled in the public demo.
Both deployment enablement and an operator-granted `expert_r.execute` account
capability are required. `expert.r.v1` runs a submitted script against one
caller-owned checkpoint in a fresh digest-pinned container with
no network, no project-storage mount, a read-only root, non-root identity, dropped
capabilities, and CPU/memory/PID/time bounds. The output mount is a 200 MiB tmpfs,
so a script cannot consume the shared host disk before post-run validation. The
broker also reserves expected work/archive capacity in process and rejects a run
unless both work and durable-storage filesystems retain an operator-configured
free-space reserve. Up to 50 bounded output files (200 MiB total) are retained as
one private archive; a derived `.rds` may be retained only in this untrusted
Expert R artifact tier, and an
exact byte-for-byte copy of the input is rejected even if it uses another allowed
extension. Those controls provide workload containment and tenant isolation, not
data-loss prevention against an authorized data owner: R can transform or encode
input-derived data. Results and output bundles stay creator-private until an
explicit audited branch publish. Source is removed from terminal job records while
its hash and input/profile/image/output provenance remain. Approved users can
privately import up to five selected CSV, TSV, text, JSON, or RDS files through the
server-controlled picker; those files are owner/project scoped, mounted read-only,
and addressed in R only by server-generated IDs. Owner-visible script failures use
a short fixed, path-free explanation. Sandbox RDS inputs and outputs can be reused
only by downloading/re-importing them through another isolated Expert R run; they
are never promoted into the trusted guided-analysis runtime because RDS
deserialization is an executable-code boundary. Runtime package install is
unavailable; operators manage access with
`npm run expert-r-access -- <grant|revoke|status> <email>`.

The spatial workflow currently supports one classic 10x Visium Space Ranger ZIP
containing `filtered_feature_bc_matrix.h5` plus its `spatial/` directory. The
server inspects a bounded archive inventory first and enables the run only after
the matrix, positions, scalefactors, and low-resolution image pass validation.
The allowlisted `spatial.seurat.v1` worker independently validates and extracts
only those required entries, loads counts/image/coordinates with Seurat, performs bounded QC,
normalization, PCA, clustering, and UMAP, and saves a reusable checkpoint with
lineage and provenance. Visium HD, Xenium, arbitrary spatial layouts, and
multi-sample spatial integration are not yet supported.

The approved multi-condition preparation workflow accepts 2-48 separately
uploaded, validated 10x HDF5 datasets from one project. Each dataset is bound to
one unique sample name and an explicit condition, with optional donor and batch
labels. The allowlisted `seurat.multisample.v1` worker resolves every dataset from
the claimed project job, merges the count matrices with unique cell identifiers,
adds `sample_id`, `condition`, `donor_code`, and `batch` metadata, runs the bounded
Seurat preprocessing recipe, and saves one reusable checkpoint-backed result. It
does not perform automatic batch correction or make a biological condition claim.
The UI reports when fewer than two samples are present in a condition because the
downstream pseudobulk gate will reject that comparison.

Study Design may register more than two conditions, but each saved
`condition.pseudobulk_de.v1` run is one explicit numerator-versus-denominator
contrast. It requires at least two independent samples or donors in each selected
condition, supports donor-paired designs only when donor identities match, and
runs edgeR quasi-likelihood pseudobulk separately per cell type. Unpaired runs
use exactly `~ condition`; paired runs use exactly `~ donor + condition`.
Blocking-factor or covariate requests fail before queueing and again at the worker
boundary, so no accepted design term is silently discarded. Multi-arm omnibus
models, general covariate formulas, and automatic batch correction/integration of
multiple raw condition datasets are not implemented. The approved multi-condition
workflow can now ingest and merge separate raw 10x HDF5 samples into one saved
analysis with explicit sample/condition metadata. The existing Batch Integration tab can
apply Harmony or Seurat CCA to 2-100 technical-batch labels already present in one
loaded Seurat object; it is not a multi-file importer or a substitute for a
biological condition contrast.

The public website demo uses `deploy/compose.demo.yml` as an overlay on a wholly
separate Compose project. It provisions temporary guest projects from one
operator-reviewed canonical checkpoint plus a remapped sample/condition/contrast
design, disables uploads and Expert R, permits one active heavy job per guest and
two globally, and requires the scheduled `demo:cleanup` operation to remove
expired guest projects and files. `deploy/compose.demo-free-tier.yml` adds a
resource-capped ARM64/Caddy candidate for a small public synthetic-data demo; see
the deployment guide before using it. The disposable demo acceptance creates the
real synthetic checkpoint and drives Chromium through UMAP and exploratory
analysis; the ARM64 public host remains a separate required acceptance target. Demo
credentials, Postgres, storage volumes, R tokens, and session secrets must never
be shared with a private deployment.

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
local loaders and live mutations, routes 10X H5 upload to Approved workflows, and
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
[docs/architecture.md](docs/architecture.md#testing--ci-notes) for what each does
and does not prove (and which runs in CI).

## Documentation

Keep this README and the relevant files in `docs/` up to date when changing
behavior, setup instructions, or security boundaries.
