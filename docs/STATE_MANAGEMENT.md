# State Management & Caching

The application manages state across three distinct layers to provide a seamless user experience while dealing with heavy computational workloads.

## 1. R Environment State (`global_obj`)

Because loading and initializing a 10x matrix takes significant time and memory, the R Plumber process maintains a stateful environment. 
- The target Seurat object is stored in memory as `global_obj`.
- Pipeline steps (QC, PCA, UMAP) sequentially modify this object.
- Live state is private to the authenticated user/object pair. Browser calls send
  only the selected DB analysis object id (`ao_*`); Express verifies ownership
  and injects the server-derived R state key before proxying to Plumber.
- The UI probes `/session-id` to detect the current R process session. It does
  not restore live objects from client-stored paths or localStorage metadata.
- If the browser refreshes after the R process has lost live memory, DB object
  metadata may still be visible while interactive R endpoints honestly report
  that the live object is not attached. Checkpoint restore is a separate
  worker-backed flow and is not wired into this UI slice.

## 2. React UI State & `localStorage`

The React frontend uses standard component state (`useState`) for transient UI interactions (dropdowns, typing).

For configurations that should survive a page reload (e.g., the number of principal components chosen, or the active workspace), the app uses `localStorage`:
- **`useTabParams`:** A custom hook that synchronizes a state object with `localStorage`. Keys are scoped by `userEmail`, `objectId`, and `tabId` so that configurations for "Dataset A" don't leak into "Dataset B".
- **Project/object selection:** Backend projects and DB-backed analysis objects
  are the source of truth. localStorage may cache only the selected project id
  and selected analysis object id as UI preferences. If a cached id is not
  returned by the backend, the UI clears it and asks the user to select or create
  a real backend project/object.
- Legacy `benchone_ws_*` workspace blobs may exist from older builds, but this
  slice intentionally ignores them as durable project/object truth.

The PBMC demo load path now creates a DB-backed project analysis object first,
then calls the live R load endpoint with that verified `ao_*` id. Immediate
PBMC demo -> Quality Control uses the verified object id. localStorage no longer
stores fake durable projects, fake durable analysis objects, fake lineage, fake
jobs, or project roles.

## 3. Provenance & SQLite Cache (Express + SQLite)

To prevent re-running heavy computations (like UMAP or Clustering) when the user navigates between tabs or restarts the app, the Express server maintains an SQLite database (`better-sqlite3`, opened by `server.js` — not Electron; this app no longer has an Electron main process or IPC layer).

### Cache Keys
Every mathematical pipeline step generates a deterministic cache key consisting of:
1. `operation`: (e.g., 'umap')
2. `rSessionId`: The unique ID of the currently loaded `global_obj`. If the backend crashes and restarts, the session ID changes, busting all caches to guarantee the UI reflects the true backend state.
3. `params`: The specific mathematical parameters used (e.g., `dims=15, n_neighbors=30`).

*Note on Cache Invalidation:*
In earlier versions, if a user re-ran an upstream step (like QC) with different parameters, the downstream steps (like PCA) would incorrectly serve cached results computed on the old cell population.
**Current Architecture:** We rely on the `rSessionId` to act as the global data version. If the user drastically changes upstream data, the pipeline state must be explicitly reset.

### Session Hydration (`hasHydrated`)
When a component like `PCA.jsx` mounts, it checks if it has hydrated. If `sessionReady` is true and the previous pipeline step is complete, it triggers a `runStep(isInitial = true)`.
This calls the API with `onlyIfCached: true`. The Express server checks the SQLite database; if a match is found, the component populates instantly without waking the R backend.

## State Sync Issues to Watch For
- **Live state vs. metadata:** A DB analysis object record can outlive its live R
  memory. The UI should show that state explicitly instead of pretending a full
  durable checkpoint restore has occurred.
- **Session probe timing:** If React components attempt to hydrate before the
  current `rSessionId` is known, they will miss the cache. `App.jsx` handles this
  by blocking hydration until `sessionCheckDone` is true.
- **Not added in this slice:** pathway enrichment, CellChat, arbitrary custom R
  scripts, artifact downloads, object storage, generated reproducibility
  scripts, report generation, secure cookie sessions, server-side token
  revocation, shared project live R state, and production-grade runtime isolation.
