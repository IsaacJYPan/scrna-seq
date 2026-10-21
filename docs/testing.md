# Testing

Run checks from the repository root after `npm ci`.

```powershell
npm run lint
npm run test:frontend
npm run test:tools
npm run build
```

`npm run test:unit` also needs a local R installation with the analysis packages.
The [R Dockerfile](../r-backend/Dockerfile) lists the release dependencies.

## Backend tests

Backend tests empty and rebuild their database tables. Create a database reserved
for tests and set `DATABASE_URL` in the shell where you run them:

```powershell
docker compose up -d postgres
docker compose exec postgres createdb -U scrna scrna_test
$env:DATABASE_URL = 'postgres://scrna:scrna@127.0.0.1:5432/scrna_test'
npm run test:backend
```

If `scrna_test` already exists, skip `createdb`. On macOS or Linux, use
`export DATABASE_URL=postgres://scrna:scrna@127.0.0.1:5432/scrna_test` instead.
Use a separate shell for the development app so it keeps its own database setting.

## Browser checks

Install Chromium with `npx playwright install chromium` (`--with-deps` on Linux).
Choose the check that covers the change:

| Command | What it exercises |
| --- | --- |
| `npm run test:visual:smoke` | Layout and interactions with simulated API replies |
| `npm run test:ui-interactions` | Pointer, keyboard, and touch workflows with simulated API replies |
| `npm run test:workbench-ui` | Authenticated workbench at desktop and phone widths, in both themes |
| `npm run test:plots` | SVG/WebGL charts, updates, resizing, and PNG/SVG exports in Chromium |
| `npm run test:deployment:browser` | Built frontend, real Express and PostgreSQL, deterministic R test service |
| `npm run test:demo-browser` | Guided demo against `PUBLIC_DEMO_ORIGIN`, including real Seurat stages |

Run `npm run build` before `test:workbench-ui`. For `test:ui-interactions` against
the production build, build first and append `-- --production`. The visual,
interaction, and workbench suites simulate services and require no R. Use the
deployment checks to exercise the API and database.

`test:deployment:browser` needs `DATABASE_URL` with permission to create a
disposable database. For the full demo stack, including container setup and
cleanup, see [the demo guide](demo.md#verify-locally).

Screenshots, recordings, and reports are written under `playwright/report/`:

- `ui-interactions/` for pointer, keyboard, and touch checks;
- `full-workbench/after/` for the workbench;
- `scientific-charts.png` for plot rendering;
- `guided-demo/` for the public demo check.

Native Electron connection checks are available as `test:desktop:ssh-ui` and
`test:desktop:tunnel-ui`; both use disposable real SSH services.

## Full app tour

The extended tour can replay measured plot values from a prepared PBMC3k
checkpoint. Export it with Seurat and jsonlite installed:

```powershell
Rscript scripts/export-ui-review-pbmc.R checkpoint.rds output.json
$env:UI_REVIEW_PBMC_DATA = (Resolve-Path output.json).Path
npm run build
npm run test:app-ui-tour
npm run test:app-ui-hover
npm run test:app-ui-auth
```

Alternatively, save the exported JSON at
`playwright/report/ui-audit/data/pbmc-ui-data.json`. The tour checks navigation,
drafts, scrolling, job submissions, chart interactions, exports, dialogs, and
authentication at 1440px and 390px in both themes. Plot values are replayed;
services and job admission are simulated. Inspect graph pixels visually: the
automated accessibility scan covers controls and labels, excluding the bulk
scatter and heatmap graphics.

`npm run record:app-ui` records a paced walkthrough with chapter timestamps.
`node scripts/verify-app-ui-tour.js --pipeline-layout` checks pipeline selection,
responsive step rows, settings, and navigation. Tour outputs are in
`playwright/report/ui-audit/`, with videos in `walkthrough/` and pipeline checks
in `pipeline-layout/`.
