# scRNA-seq Dashboard

A **web-based** single-cell RNA-seq analysis workbench: a React/Vite single-page
app, an Express server that handles authentication and proxies analysis calls,
and an R Plumber/Seurat backend that does the computation. It is a local/dev
oriented project — useful for analysis and lineage tracking on your own machine
or a trusted environment — **not** a production-complete, multi-tenant service.

> **Note:** This is not an Electron desktop app. Earlier iterations were packaged
> with Electron; that entry path has been removed. The runtime entrypoint is the
> Express server (`server.js`, `npm start`). The browser API client object in
> `src/api.js` is still named `electronAPI` for historical compatibility, but it
> is a thin `fetch` wrapper to the Express API. See `docs/architecture.md`.

## Architecture & trust boundaries

```
Browser (React/Vite SPA)
        │  HTTP + Bearer token
        ▼
Express server (server.js)   ◄── the auth + proxy tier
   • authenticates every request
   • scopes data per user
   • validates vault file paths
   • injects the R API token + server-derived state key
        │  internal, localhost only
        ▼
R Plumber / Seurat backend (r-backend/)   ◄── compute only, never user-facing
```

**Express is the authentication/authorization and proxy tier. The R Plumber
backend must not be exposed as the user-facing service.** It trusts the
`X-API-Token` and server-derived `X-Object-ID` that Express injects; it performs
no user authentication of its own. Exposing R Plumber directly to users (or to
the public network) bypasses all authentication, per-user data scoping, and path
validation. R Plumber should only ever be reachable from the Express tier
(e.g. bound to `127.0.0.1` or a private network).

## Running locally

```bash
npm install
npm run dev      # Vite dev server + Express (which spawns local R Plumber)
```

Requires a local R installation with Seurat (and the packages listed in
`r-backend/`). See `docs/architecture.md` and `docs/R_BACKEND.md` for details.

## Docker (local R backend only)

The provided `docker-compose.yml` containerizes **only the R Plumber backend**
as a local convenience so you don't have to install R/Seurat on the host. It is
**not** a collaborator/production deployment path, and the R port it exposes is
**not** an authenticated, user-facing endpoint — it is meant to sit behind the
Express tier on the same trusted host.

### Mounting local datasets

To analyze local datasets, map them into the container with volume mounts in
`docker-compose.yml`:

```yaml
services:
  r-backend:
    build: ./r-backend
    ports:
      # Bound to localhost only — R Plumber is not authenticated and must not be
      # reachable by users directly. Express (on the host) proxies to it.
      - "127.0.0.1:8000:8000"
    volumes:
      # Map your local "data" directory to "/app/data" inside the container
      - ./data:/app/data
```

Run `docker-compose up -d` to start the backend. Any data placed in your local
`./data` folder is then available to R at `/app/data`.

> **Do not** publish the R Plumber port to a public interface or treat it as the
> service users connect to. All user traffic must go through the Express server,
> which performs authentication and per-user authorization.
