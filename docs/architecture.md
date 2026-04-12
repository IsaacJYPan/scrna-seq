# BenchOne scRNA-seq Research Platform Architecture

This document describes the architectural intent, state management, and interaction contracts of the BenchOne scRNA-seq application.

## Overview

The application is built on a decoupled **Electron+React** frontend and an **R (Plumber)** backend. 

*   **Frontend**: Responsible for UI, orchestrating user actions, managing workspace states (objects, branches), and rendering data (via `react-plotly.js`). It is stateless in terms of bioinformatics processing.
*   **Backend**: A stateful R instance running `plumber`. It holds a singleton Seurat object (`global_obj`) in memory and performs actual computations using Seurat v5.
*   **Database**: A SQLite layer (via `sqlite3` in Node/Electron) records *provenance*—a strict, immutable ledger of all operations applied to the dataset.

---

## 1. Interaction Contract & State Flow

### The "One Object" Backend Model
Currently, the R backend is designed around a **singleton** Seurat object (`global_obj`). 

*   **Rule**: The frontend can hold multiple "Object" records in its workspace state, but the backend only processes *one* dataset at a time. 
*   **Implication**: Switching branches or objects in the frontend UI *must* be accompanied by resetting the backend state if they represent different points in the DAG (Directed Acyclic Graph). *(Note: Fully restoring the backend from arbitrary provenance points is a heavy operation and is partially mocked at present. Future implementations will need to reconstruct state using the provenance ledger).*

### Provenance Tracking (DAG)
Every mutating API request to the backend goes via `callApi()` in `App.jsx`, passing:
1.  `parentIds`: The UUID of the preceding step.
2.  `operation`: The name of the action (e.g., `qc`, `pca`).
3.  `step`: The identifier for invalidation (e.g., if you run `qc`, it invalidates downstream `pca`, `cluster`, `umap` steps).

The Plumber endpoint does the math, then calls an internal R wrapper `make_provenance()`. This captures:
*   The exact valid R script required to reproduce the action.
*   Any returned metrics (e.g., `post_filter_cells`, `median_mt`).

The frontend receives this payload and injects it into the SQLite DB, advancing the `activeBranch` to the new node's UUID.

---

## 2. Component Hierarchy & Roles

*   **`App.jsx`**: The orchestrator. Manages the active workspace session, tab routing, and the critical `callApi()` wrapper that manages the pipeline's sequential logic and cache invalidation.
*   **`Workspace.jsx`**: The entry point. Manages loading data via the `/load-data` endpoint and viewing global object metrics.
*   **`Sidebar.jsx`**: Global navigation. Contains hardcoded gates preventing navigation to downstream steps (e.g., UMAP) if upstream prerequisites (e.g., Clustering) are not flagged as true in `pipelineState`.
*   **Pages (e.g., `QualityControl.jsx`, `PCA.jsx`)**: Purely UI and presentation components. They should *never* calculate complex bioinformatics logic. They must call the Plumber API and display the returned `result`.

---

## 3. API Guidelines & Debugging Rules

When adding or modifying features, adhere to the following contracts:

### 1. HTTP Methods
*   Use `GET` for all standard operations where the parameters are small (e.g., thresholds, dimensions). Plumber parses `req$body` poorly in certain configurations, so `GET` query parameters are strictly preferred and more robust for this application's architecture.

### 2. No Mock Data
*   Never use `Math.random()` or hardcoded arrays to simulate biological visualizations. 
*   If an R backend implementation is missing, use the "Not Yet Implemented" placeholder pattern seen in `BatchIntegration.jsx` and `Publication.jsx`. Displaying fake data to a researcher fundamentally breaks trust in the application.

### 3. Error Handling
*   The R backend wraps critical functions in `tryCatch`. If an error occurs, it returns `list(error = "Message")`.
*   The frontend `callApi` function checks for this `data.error` property and surfaces it to the component. Components *must* handle and display this error state clearly (using the red `AlertTriangle` banner pattern).

### 4. R Data Type Quirks
*   JSON serialization in R (via `jsonlite`) often casts single scalar variables (like the string "quality-control") into an array of length 1: `["quality-control"]`.
*   **Frontend Defense**: Always defend against array wrapping when reading strings from the backend. E.g., `const op = Array.isArray(node.operation) ? node.operation[0] : node.operation;`.

### 5. Dataset Loading Constraints
*   The `/load-data` endpoint utilizes Seurat's initialization parameters `min.cells` and `min.features` to prune extremely sparse features prior to formal QC.
*   **Impact**: These initial bounds intrinsically eliminate empty droplets and unexpressed genes before the pipeline computes downstream metadata. If downstream components report missing features, they may have been pruned at initialization.

---

## 4. Current Limitations & Future Work

1.  **Backend Concurrency**: Standard R is single-threaded. Running a long UMAP computation blocks subsequent requests (like fetching gene names). Moving to `callr` or background jobs is a future optimization target.
2.  **Dataset Branching**: The UI supports "Forking" a branch, but the backend mechanism to revert `global_obj` to an earlier state is not fully instantiated.
3.  **Missing Modules**: Batch Integration (Harmony) and Trajectory/Pseudotime analysis remain fully unimplemented placeholders.
