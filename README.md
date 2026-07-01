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

## Running Locally

```bash
npm install
npm run dev
```

This starts Vite plus the Express server, which starts local R Plumber in the
current development setup. A local R installation with the required Seurat
packages is expected.

Useful checks:

```bash
npm run lint
npm run build
npm run test:backend
npm run test:frontend
```

R/workflow checks exist for the hardened paths, including:

```bash
npm run test:r-state-proxy
npm run test:pbmc-parent
npm run test:checkpoint-load
npm run test:deg-markers
npm run test:visual
npm run test:visual:db-flow
```

## Current Boundaries

- Browser auth is still localStorage bearer-token based; secure cookie sessions
  and server-side token revocation are not implemented.
- Backend projects, DB-backed analysis objects, jobs, artifacts, checkpoints,
  and lineage are the durable source of truth.
- localStorage may cache selected project/object IDs and UI preferences only; it
  is not authoritative for projects, analysis objects, lineage, jobs, roles, or
  checkpoints.
- Live R state is private, transient, and keyed by server-derived user/object
  state. Project metadata visibility does not grant live R access.
- The worker is opt-in and allowlisted. Current real workflow handlers include
  PBMC pipeline, checkpoint load, DEG marker finding, runtime check, and object
  inspection.
- Pathway enrichment and CellChat are not production-integrated worker workflows.
- There is no public artifact download surface, object storage, generated report
  export, arbitrary R execution, or shared project live R state.
- R 4.5.x is the intended local development target; report if R 4.6.x is
  detected.

## Documentation Policy

Tracked markdown is intentionally limited to this README. Development notes,
agent workflow rules, design/spec material, and current-state handoff context
belong in local ignored markdown under `.project/codex/`.

If behavior, tests, security boundaries, or workflow expectations change, update
the relevant local docs in `.project/codex/` at the same time as the code.
