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

### Current local/dev limitations

- R 4.5.x is the intended local development target for now. Diagnostics report
  the detected R runtime and warn when it is outside the R 4.5.x target; startup
  is not blocked solely because a different R version is detected.
- Browser sessions still use localStorage bearer tokens. Logout clears the
  current local auth/session keys, but this is not a production-grade session
  model with secure cookies or server-side token revocation.
- The React workspace still contains legacy/ephemeral local UI state while the
  backend project, dataset, analysis-object, job, artifact, and lineage model is
  DB-backed. That workflow mismatch is a known follow-up and is not solved here.
- Pathway Enrichment, CellChat, Custom Script, and Cell Annotation are not
  production-integrated workflow actions. They are hidden or disabled as future
  work; arbitrary R script execution remains out of scope.

### Auth rate limiting & reverse proxies

The auth endpoints (`/api/auth/login`, `/api/auth/signup`) have a simple,
single-node, in-memory rate limiter keyed by client IP (`req.ip`). It is basic
defense-in-depth against credential stuffing / signup abuse, **not** a
distributed throttle.

Express is **not** configured with `trust proxy`, so `req.ip` is the
*direct* socket peer. This is correct when Express terminates client connections
directly. If you put Express behind a reverse proxy / load balancer / CDN in a
production deployment, you must configure trusted-proxy handling intentionally:

- If you do **nothing**, every client appears as the proxy's IP, so all users
  collapse into one rate-limit bucket (one abuser can lock everyone out).
- If you enable `trust proxy` **carelessly** (e.g. trusting `X-Forwarded-For`
  from an untrusted hop), clients can spoof their IP and bypass the limit.

Only enable `trust proxy` with an explicit, correct trusted-hop configuration
for your specific proxy. A multi-node deployment should additionally replace the
in-memory limiter with a shared store (e.g. Redis). Do **not** casually turn
`trust proxy` on.

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
