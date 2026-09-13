# TraceOmics

TraceOmics is a browser application for single-cell and spatial transcriptomic
analysis. Organize datasets into projects, run Seurat workflows, explore plots,
and share saved analyses with collaborators. Each saved analysis records its
inputs, parameters, and history.

## Run locally

You need Node.js 22.15–24, Docker Desktop with Linux containers running, and R
with the analysis packages installed. The release image uses R 4.5.3. See the
[development guide](docs/development.md#check-the-local-r-installation) for R setup.

From PowerShell:

```powershell
npm ci
docker compose up -d postgres
$env:DATABASE_URL = 'postgres://scrna:scrna@127.0.0.1:5432/scrna'
npm run init:postgres
npm run dev
```

On macOS or Linux, use `export DATABASE_URL=postgres://scrna:scrna@127.0.0.1:5432/scrna`
in place of the PowerShell assignment.

Open [localhost:5173](http://localhost:5173) and create a development account.
`npm run dev` starts the frontend, API, local R service, and job worker. Stop them
with `Ctrl+C`; stop the database separately with `docker compose stop postgres`.

## What you can do

- Prepare single-sample or multi-sample 10x datasets and classic Space Ranger
  Visium datasets with Seurat.
- Inspect quality metrics, normalize expression, cluster cells, and explore
  PCA, UMAP, gene expression, heatmaps, and marker genes.
- Run ranked pathway enrichment, replicate-aware pseudobulk comparisons, and
  single-context CellChat candidate analysis.
- Save analysis checkpoints, view run history, export selected results, and
  fork a collaborator's saved analysis into your own workspace.
- Choose a pipeline from the shared catalog, or import a versioned R pipeline
  and run it through the private isolated runner. See [sharing pipelines](docs/pipelines.md).

Cell annotation, cross-condition CellChat, and publication report generation
are not yet available. The [architecture guide](docs/architecture.md) distinguishes
working browser features from backend-only functionality.

## Project structure

| Directory | Contents |
| --- | --- |
| `src/` | React pages, shared UI, workspace state, and API client |
| `backend/` | Authentication, projects, job workers, storage, and PostgreSQL schema |
| `r-backend/` | Plumber API and scientific analysis functions |
| `shared/` | Contracts used by the frontend and backend |
| `scripts/` | Development tools, administration, and integration checks |
| `deploy/` | Production and demo Compose profiles |
| `desktop/` | Electron shell for connecting to a hosted server |

## Verify changes

```powershell
npm run lint
npm run test:frontend
npm run test:tools
npm run test:unit
npm run build
```

Backend tests reset their database. Use a separate test database as described in
[testing](docs/development.md#testing-without-erasing-your-development-data).
`npm run test:visual:smoke` checks browser layout and interactions with simulated
API responses. `npm run test:deployment:browser` uses a real API and PostgreSQL
with a deterministic R test service.

## Deploy a demo

Start with the [student demo guide](docs/demo.md). The [deployment guide](docs/deployment.md) covers a Linux host with Docker Compose,
HTTPS, persistent storage, backups, and a small public tutorial. The constrained
demo profile uses synthetic data and disables uploads; it targets a host with
2 OCPUs and 12 GB RAM. Hosting availability and student credits depend on the
provider and account. This is not a static-site deployment: R and PostgreSQL
must remain available alongside the web server.

For a private deployment, the operator manages accounts and recovery. Keep R
and PostgreSQL on the private network; Express handles user authentication and
project access. Shared results are saved checkpoints, not another user's live
R session.

## Further reading

- [Development and testing](docs/development.md)
- [Architecture and feature status](docs/architecture.md)
- [Analysis workflows and interpretation](docs/analysis-workflows.md)
- [Pipeline registry](docs/pipelines.md)
- [Student demo setup](docs/demo.md)
- [Deployment and operations](docs/deployment.md)
- [Windows desktop distribution](docs/deployment.md#windows-desktop-application)
