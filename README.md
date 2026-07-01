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

## Architecture Status

The backend has moved ahead of the React UI: several subsystems are implemented
and tested at the API/DB layer but are **not yet surfaced in the app**. Do not
assume "implemented and tested" means "usable in the UI".

At a glance:

- **UI-wired:** auth, organizations/projects, DB-backed analysis objects
  (`ao_*`), live R object state, QC/Normalize/PCA/Cluster/UMAP/plots, DEG (via
  the **legacy** `/api/r/deg` path), provenance/figures/cache.
- **Backend implemented with partial read-only UI visibility:** durable jobs,
  artifacts/checkpoints, and lineage exist in the backend, and the React UI now
  includes a read-only Jobs & Artifacts / durable history surface for safe
  metadata visibility. Job launching, checkpoint loading, artifact downloads,
  and lineage mutation are still not UI-wired.
- **Backend-only (implemented + tested, no UI yet):** project members/RBAC
  endpoints, datasets, the opt-in worker loop, and the PBMC pipeline /
  checkpoint-load / DEG-marker / runtime-check / object-inspect workers.
- **Not implemented (product):** pathway enrichment, CellChat, cell annotation,
  custom/arbitrary R execution, reports, generated scripts, artifact downloads,
  object storage, secure cookie sessions, shared project live R state.

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

This starts Vite plus the Express server, which starts local R Plumber in the
current development setup. A local R installation with the required Seurat
packages is expected.

Fast checks (no R backend required):

```bash
npm run lint
npm run build
npm run test:backend    # backend CONTRACT tests (incl. backend-only subsystems)
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
