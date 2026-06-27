# State Management & Caching

The application manages state across three distinct layers to provide a seamless user experience while dealing with heavy computational workloads.

## 1. R Environment State (`global_obj`)

Because loading and initializing a 10x matrix takes significant time and memory, the R Plumber process maintains a stateful environment. 
- The target Seurat object is stored in memory as `global_obj`.
- Pipeline steps (QC, PCA, UMAP) sequentially modify this object.
- **Session Restoration:** When the app is closed and reopened, the R state is lost. The frontend triggers `/restore-session` which loads a saved `.rds` file back into `global_obj` and resets the `r_session_id`.

## 2. React UI State & `localStorage`

The React frontend uses standard component state (`useState`) for transient UI interactions (dropdowns, typing).

For configurations that should survive a page reload (e.g., the number of principal components chosen, or the active workspace), the app uses `localStorage`:
- **`useTabParams`:** A custom hook that synchronizes a state object with `localStorage`. Keys are scoped by `userEmail`, `objectId`, and `tabId` so that configurations for "Dataset A" don't leak into "Dataset B".
- **Workspace State:** The array of active Seurat objects/projects is serialized to `localStorage` on every change and restored on login. Note: This only saves the metadata (name, cell count, file path), not the data itself.

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
- **Race Conditions on Restore:** If React components attempt to hydrate before the `rSessionId` is successfully restored from the `.meta.json` file, they will miss the cache. `App.jsx` handles this by blocking hydration until `sessionCheckDone` is true.
