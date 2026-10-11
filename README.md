# TraceOmics

TraceOmics is a browser application for single-cell and spatial transcriptomic
analysis. Organize datasets into projects, run Seurat workflows, explore plots,
and share saved analyses with collaborators. Each saved analysis records its
inputs, parameters, and history.

## Run locally

You need Node.js 22.15–24, Docker Desktop with Linux containers running, and R
with the analysis packages installed. The release image uses R 4.5.3; its
required packages are listed in [the R image definition](r-backend/Dockerfile).
For a containerized installation, use the [deployment guide](docs/deployment.md).

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
- Install [workflows with their own tabs](docs/workflow-pipelines.md), dependency
  locks, custom R plots, and explicitly saved workflow snapshots.

Cell annotation, cross-condition CellChat, and publication report generation
are not yet available. See [analysis workflows](docs/analysis-workflows.md) for
the supported methods and their interpretation.

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

Backend tests reset their database. Set `DATABASE_URL` to a separate PostgreSQL
database reserved for tests before running `npm run test:backend`.
`npm run test:visual:smoke` checks browser layout and interactions with simulated
API responses. `npm run test:deployment:browser` uses a real API and PostgreSQL
with a deterministic R test service.

`npm run test:ui-interactions` records pointer paths, keyboard navigation, and
touch workflows with simulated API responses. Recordings, screenshots, and the
acceptance report are saved in `playwright/report/ui-interactions/`. To check
the production build, run `npm run build` and then
`npm run test:ui-interactions -- --production`.

`npm run build` followed by `npm run test:workbench-ui` checks the full
authenticated workbench at desktop and phone widths in both themes. It records
navigation and real cursor paths, tests data-point hover and empty-space behavior,
and checks keyboard input, layout, and accessibility. The deterministic frontend
fixtures do not require R or change research data. Recordings and results are
saved in `playwright/report/full-workbench/after/`.

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

- [Analysis workflows and interpretation](docs/analysis-workflows.md)
- [Pipeline registry](docs/pipelines.md)
- [Student demo setup](docs/demo.md)
- [Deployment and operations](docs/deployment.md)
- [Windows desktop distribution](docs/deployment.md#windows-desktop-application)
