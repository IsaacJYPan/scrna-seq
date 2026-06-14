# R Backend (Plumber API)

## Overview
The computational engine of the application is a local REST API built with R and the `plumber` package. It wraps the `Seurat` bioinformatics library.

## Architecture
- **Host & Port:** Bound to `127.0.0.1:8000` for security (preventing network access).
- **Serialization:** Configured with `pr$setSerializer(plumber::serializer_json(auto_unbox = TRUE))` in `run.R`. This is critical. Without it, R converts all single-value scalars into arrays (e.g., `5` becomes `[5]`), which causes unpredictable crashes in the React frontend (like `NaN` in mathematical visualizations).

## API Endpoints

### 1. Data Loading & Subsetting
- `/load-10x`: Parses a 10x matrix and initializes `global_obj`.
- `/load-rds`: Loads an existing Seurat object.
- `/subset`: Filters cells based on metadata criteria.

### 2. Analytical Pipeline
These endpoints execute heavy computations and return JSON summaries + visualization traces.
- `/qc`: Calculates mitochondrial percentage and filters cells based on user thresholds.
- `/normalize`: Implements `LogNormalize` or `SCTransform`.
- `/pca`: Runs Principal Component Analysis and returns the variance elbow plot data.
- `/cluster`: Builds the KNN graph and finds communities using Louvain/Leiden algorithms.
- `/umap`: Calculates 2D or 3D embeddings.

### 3. Session Persistence
Because `global_obj` lives in memory, the backend must save state before the application closes.
- `/save-session`: Writes `global_obj` to an `.rds` file and writes the active `r_session_id` to a companion `.meta.json` file.
- `/restore-session`: Loads the `.rds` file and the companion metadata. This ensures that the frontend's SQLite cache (which relies on `r_session_id`) stays valid across app restarts.

## Provenance Tracking
Within the R code, successful operations are wrapped in a `make_provenance` function. This generates a standardized JSON payload that includes:
- The executed R script.
- The parameters used.
- Cell/Feature counts before and after.

The frontend receives this payload and stores it in the SQLite database, creating a permanent audit trail of the analysis.
