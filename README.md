# TraceOmics

TraceOmics is a web app for single-cell and spatial transcriptomic analysis with
Seurat. Projects keep datasets, saved analyses, plots, and run history together.
You can share a saved analysis or fork one to try different settings.

The guided PBMC3k demo starts with counts from 2,700 cells. Work through QC,
normalization, PCA, clustering, and UMAP using your own settings. Each stage runs
Seurat. Guest sessions expire, and uploads and custom R are disabled. See
[demo setup](docs/demo.md) to host it.

## Run locally

You need Node.js 22.15–24, Docker Desktop with Linux containers running, and R
with the analysis packages installed. The release image uses R 4.5.3; see the
[R image definition](r-backend/Dockerfile) for packages and installation commands.
`Rscript` must be on your PATH, or set `RSCRIPT_PATH` to its full path.

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

## Analysis tools

- Seurat preprocessing for single-sample and multi-sample 10x data, plus classic
  Space Ranger Visium data.
- QC, PCA, UMAP, gene expression, heatmaps, and marker finding.
- Ranked pathway enrichment, replicate-aware pseudobulk comparisons, and
  single-context CellChat candidate analysis.
- [Shared pipelines](docs/pipelines.md), [custom workflow steps](docs/workflow-pipelines.md),
  and a private R console on installations with the isolated R runtime configured.

Cell annotation, cross-condition CellChat, and publication report generation
are not yet available. See [analysis workflows](docs/analysis-workflows.md) for
the supported methods and their interpretation.

## Development

The React app is in `src/`, the Express API and workers in `backend/`, and the
Plumber service and analysis functions in `r-backend/`. `deploy/` holds the
Compose profiles; `desktop/` is the Electron client for hosted installations.

Start with the JavaScript checks:

```powershell
npm run lint
npm run test:frontend
npm run test:tools
npm run build
```

`npm run test:unit` runs the R checks. Backend tests reset their database: use a
separate test database before running `npm run test:backend`. The [testing guide](docs/testing.md)
covers database setup, browser checks, recordings, and which suites use simulated
services.

## Deployment

The [deployment guide](docs/deployment.md) covers Docker Compose, HTTPS, storage,
backups, and the [Windows desktop client](docs/deployment.md#windows-desktop-application).
R and PostgreSQL run alongside the web server. Keep both on the private network;
Express handles accounts and project access. Shared results are saved checkpoints,
not another user's live R session.

The default demo fixture uses synthetic data. Set `DEMO_DATASET=pbmc3k` for the
guided experience described above; the [demo guide](docs/demo.md) covers hosting
and the browser check to run before sharing a deployment.
