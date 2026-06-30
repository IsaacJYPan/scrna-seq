# Analysis pipeline integration (`pbmc.pipeline.v1`)

Implementation note for the first production-integrated scientific pipeline: the
existing PBMC/Seurat preprocessing path, wrapped as **one** allowlisted worker job
that produces a durable result analysis object, checkpoint/artifact metadata,
provenance/log records, and a lineage edge.

This document is implementation/architecture documentation only — it is **not** a
roadmap or product spec. It records where the existing analysis code lives, what this
branch reuses, the assumptions that code makes, how the branch wraps it safely, and an
audit of the still-unwrapped workflows (DEG / pathway enrichment / CellChat).

## Scope of this branch

Integrated as a real vertical slice:

> uploaded/existing analysis object → worker job → allowlisted PBMC pipeline operation
> → durable checkpoint/result analysis object → artifact metadata → lineage edge →
> provenance/job logs → safe project-readable metadata.

A completed checkpoint can then be **reattached** into the owner's private live R session
through the owner-only `checkpoint.load.v1` worker job, so downstream jobs can use it as
live input — see [Checkpoint load / reattach](#checkpoint-load--reattach-checkpointloadv1).
This stays **owner-only**; it does **not** add shared project live-R state.

**Out of scope** (unchanged, deliberately not implemented here): DEG, pathway
enrichment, CellChat, generated R script export, public downloads, object storage,
full reproducibility bundles, shared project live-R state, and production-grade runtime
isolation. Cancellation remains cooperative/status-level only (it does **not** kill
in-flight R work).

## Where the existing analysis code lives

All scientific R code is in [`r-backend/plumber.R`](../r-backend/plumber.R) as
synchronous Plumber endpoints. The pieces relevant to PBMC preprocessing:

| Step | Endpoint | Seurat calls |
| --- | --- | --- |
| Load 10x | `GET /load-data`, `POST /load-multi-10x`, `POST /load-rds` | `Read10X`, `CreateSeuratObject` |
| Normalize + HVG | `GET /normalize` | `NormalizeData`, `FindVariableFeatures` (and `SCTransform`) |
| PCA | `GET /pca` | `ScaleData`, `RunPCA` |
| Cluster | `GET /cluster` | `FindNeighbors`, `FindClusters` |
| UMAP | `GET /umap` | `RunUMAP` |
| Integrate (optional) | `GET /integrate` | Harmony / CCA |
| QC | `GET /qc`, `GET /qc-distributions` | `PercentageFeatureSet`, subsetting |

These endpoints all share two assumptions that make them unsafe to expose directly as
a production job:

1. **Global mutable state.** Each step reads and writes a process-global `global_obj`
   (`global_obj <<- ...`). State is keyed per request by the `X-Object-ID` header via a
   `session_loader` filter + a `postroute` hook that saves `global_obj` back to
   `active_sessions[[X-Object-ID]]`. A step therefore **mutates the object in place**.
2. **Synchronous, request-coupled execution.** Each endpoint runs the Seurat call
   inline and returns a large result payload (e.g. UMAP returns per-cell embeddings,
   DEG returns marker tables) intended for the interactive UI.

Provenance is produced by the `make_provenance()` helper (a script string +
parameters + package versions); RDS persistence exists via `POST /save-session` /
`POST /restore-session`, which already use `validate_path(path, "vault")` to confine
writes to a server-controlled `vault/` directory.

## What this branch reuses vs. adds

**Reuses** (unchanged scientific logic): the exact Seurat call sequence and defaults
from `/normalize` → `/pca` → `/cluster` → `/umap`, the `validate_path()` vault
confinement, and the `saveRDS(list(global=…, raw=…))` bundle format from
`/save-session`.

**Adds** (the safe wrapper):

| Layer | File | What it adds |
| --- | --- | --- |
| Job type | [`backend/database.js`](../backend/database.js) | `pbmc.pipeline.v1` in `ALLOWED_JOB_TYPES`; `pipeline_summary` artifact type; `createCheckpointArtifactForJobByWorker` (durable `local_internal` checkpoint artifact). |
| Params + key | [`backend/pbmcPipeline.js`](../backend/pbmcPipeline.js) | Fixed parameter allowlist + validator/resolver; server-allocated internal checkpoint key. |
| Bridge op | [`backend/rWorkerBridge.js`](../backend/rWorkerBridge.js) | Allowlisted `r.pbmc.pipeline.v1` operation (`POST /object/pbmc-pipeline`), server-built params body, sanitized summary/checkpoint. |
| Worker handler | [`backend/jobWorker.js`](../backend/jobWorker.js) | `pbmc.pipeline.v1` handler: ownership gate → param validation → key allocation → bridge call → result object + edge + artifacts + logs. |
| R endpoint | [`r-backend/plumber.R`](../r-backend/plumber.R) | `POST /object/pbmc-pipeline`: runs the pipeline on a **copy** of the loaded object, writes the checkpoint RDS, returns a sanitized summary. |

### Key safety property: the parent is never mutated

The existing endpoints reassign `global_obj <<-`, which mutates the input object. The
new `POST /object/pbmc-pipeline` endpoint instead binds a **local** `obj <- global_obj`
and only ever mutates `obj` (R copy-on-modify semantics for the S4 Seurat object). It
**never** reassigns `global_obj`, so the `postroute` hook re-saves the parent state
unchanged. The pipeline output is a separate derived object; the parent remains a
stable checkpoint, exactly as required.

### Job type & parameters

One job type, `pbmc.pipeline.v1`, created through the **existing** typed-job API
(`createProjectJob` → `POST /api/projects/:projectId/jobs` with
`{ jobType, analysisObjectId, parameters }`). No new public route, no public worker
route, no public R-bridge route, and no download route are added.

**Internal-only R endpoint (enforced).** `POST /object/pbmc-pipeline` is reached **only**
through the in-process worker bridge, which calls the R backend directly and does **not**
traverse the public `/api/r/*` Express proxy. Because that proxy is a catch-all, the
server explicitly **blocks** this path before any R contact
(`isInternalOnlyRProxyPath` in [`server.js`](../server.js) → `404`), so a direct
authenticated `POST /api/r/object/pbmc-pipeline` call cannot run the pipeline, write a
checkpoint, or create any durable record. The block covers every spelling of the path
(any method, trailing slash, doubled/`%2F`-encoded/backslash separators); the worker
bridge is unaffected. Enforcement lives in Node, not in a comment.

Parameters are validated server-side against a fixed allowlist
([`backend/pbmcPipeline.js`](../backend/pbmcPipeline.js)):

| Param | Type | Range / values | Default |
| --- | --- | --- | --- |
| `normalizationMethod` | enum | `LogNormalize`, `SCTransform` | `LogNormalize` |
| `scaleFactor` | int | `1 … 10000000` | `10000` |
| `variableFeatures` | int | `50 … 10000` | `2000` |
| `pcaDims` | int | `2 … 100` | `50` |
| `clusterDims` | int | `2 … 100` | `15` |
| `clusterResolution` | number | `0.01 … 10` | `0.8` |
| `umapDims` | int | `2 … 100` | `15` |
| `umapComponents` | enum | `2`, `3` | `2` |
| `umapNeighbors` | int | `2 … 200` | `30` |
| `umapMinDist` | number | `0 … 1` | `0.3` |
| `seed` | int or null | `0 … 2147483647` | `null` (R samples + records a seed) |

Policy:

- **Unknown parameter names are rejected** (strict), never silently ignored.
- Strings are **not** coerced to numbers — a non-numeric value for a numeric parameter
  is rejected, so nothing string-like (which could carry code or a path) can reach R.
- No parameter is interpolated into R code, used as a file path, or used to choose an R
  function. R consumes each value as a typed Seurat argument only.
- Invalid params **fail the job before any R mutation** (the handler validates before
  contacting R) and the failure message is safe (no secrets/paths).
- Defaults are recorded (`defaultsApplied`), and the **resolved** params are stored in
  the result object metadata, the `pipeline_summary` artifact metadata, and job logs.

### Checkpoint storage

`local_internal` storage is implemented. The Node server **allocates** the checkpoint
key (`checkpoints/<jobId>/<hex>.rds`) from server-controlled ids only — no client input
contributes to it, and it is a relative, traversal-free path. The key is sent to R in
the server-built request body; R confines it to the vault again via `validate_path()`
and writes the RDS there, returning the **sha256 checksum + size** (not the path).

The key is persisted in the checkpoint artifact's `storage_uri` column, which
`toPublicJobArtifact` **always strips** — so the path/key never reaches an API
consumer. checksum/size/storageKind are kept as safe public descriptors. There is **no
download route** in this branch.

> **Filesystem note.** The checkpoint bytes live on the R backend's own `vault/`
> volume. Node does not read them back (no download), so the integration does not
> depend on Node and R sharing a filesystem view — R owns path resolution. Re-attaching
> a saved checkpoint as live R state under the result object's canonical key is now
> available as the owner-only `checkpoint.load.v1` worker job (see the *Checkpoint load /
> reattach* section below).

### Worker success / failure behavior

On success the handler creates **exactly one** result analysis object (a child
checkpoint of the input object), **one** parent→result lineage edge, **one** `checkpoint`
artifact (`local_internal`), and **one** `pipeline_summary` artifact (metadata-only); it
links `job.result_analysis_object_id` and writes durable logs. All five durable records
are created in **one atomic, claim/lease-guarded transaction**
(`completePbmcPipelineResultByWorker`): the result object, job link, lineage edge,
checkpoint artifact, and summary artifact commit **together or not at all**, so a failure
(including a claim loss or a bad artifact insert) can never leave a failed job linked to a
result object/edge with missing artifacts. All DB records are created **only after** R
confirms a durable checkpoint save (saved + checksum). On R failure, invalid params,
cancellation, or claim loss, **no** successful result object/edge/artifact is created, and
the claim guard (plus the `result_analysis_object_id IS NULL` re-check) prevents two
workers from duplicating any of them.

> **Orphan-file note.** The R checkpoint RDS is written by the R backend *before* the DB
> transaction runs, so a DB rollback can leave an orphaned internal file on the R vault.
> That is acceptable here — there is no public download route and Node may not share the
> R vault filesystem — and is recorded as a storage-lifecycle follow-up. The invariant
> that holds is that DB state never partially commits a successful-looking result.

### What is exposed (and what is not)

Project members read safe metadata through the existing role-checked artifact/lineage
routes. Responses never include local paths, the storage URI/key, R state keys, the API
token, the internal R URL, R stack traces, expression matrices, per-cell/gene tables,
embeddings, or large gene lists. Bridge errors are pre-sanitized to stable coded
messages.

## Checkpoint load / reattach (`checkpoint.load.v1`)

A completed internal checkpoint produced by `pbmc.pipeline.v1` is a durable RDS on the R
vault, but it is **not automatically usable as live R state** for downstream jobs. The
`checkpoint.load.v1` worker job closes that gap: it loads a completed checkpoint **back
into the object owner's private live R session** under the canonical object key, so a
later job (e.g. a future DEG/pathway/CellChat job) can use it as live input.

This is a **worker-only** operation. Direct public R-proxy execution of the load endpoint
is **blocked** — an authenticated `POST /api/r/object/checkpoint-load` returns `404`
**before any R contact** (`server.js` `isInternalOnlyRProxyPath`, alongside the existing
`/object/pbmc-pipeline` block), every spelling of the path and every method, with no
durable side effect. Only the in-process worker bridge reaches the R endpoint.

| Layer | File | Added |
| --- | --- | --- |
| Job type | [`backend/database.js`](../backend/database.js) | `checkpoint.load.v1` in `ALLOWED_JOB_TYPES`; `checkpoint_load` artifact type; `getLoadableCheckpointForAnalysisObject` selector. |
| Bridge op | [`backend/rWorkerBridge.js`](../backend/rWorkerBridge.js) | Allowlisted `r.checkpoint.load.v1` operation (`POST /object/checkpoint-load`), server-built body (internal key + expected checksum/size only), sanitized load summary. |
| Worker handler | [`backend/jobWorker.js`](../backend/jobWorker.js) | `checkpoint.load.v1` handler: ownership gate → server-selected checkpoint → bridge call → one metadata-only summary artifact. |
| R endpoint | [`r-backend/plumber.R`](../r-backend/plumber.R) | `POST /object/checkpoint-load`: validates the server key via `validate_path`, verifies the checksum **before** `readRDS`, validates the bundle shape, reattaches into the request's `X-Object-ID` session only. |

### Owner-only (v1)

v1 is **owner-only**. The analysis object being loaded must be **owned by the job
creator**: the worker verifies ownership with the same `verifyAnalysisObjectOwner` gate
the `/api/r/*` proxy uses, and `getLoadableCheckpointForAnalysisObject` re-checks
ownership + project scope, **before any R contact**. A project co-member or admin who does
**not** own the object is rejected (404-style) — project membership grants durable
metadata reads, **not** live R load. Viewers cannot create the job; non-members get 404;
cross-project / malformed objects are rejected.

This bound is deliberate: the live-R boundary is owner-verified and keyed on
`ownerUserId + analysisObjectId`. Collaboration today happens through durable
objects/artifacts/lineage, not shared live R state. A **collaborative checkpoint
clone/fork/load** (letting a co-member load another user's checkpoint into *their own*
session) would require a larger user-workspace/session-ownership design and is a future
follow-up — it is **not** implemented here.

### Checkpoint selection (server-controlled)

The worker never accepts a client storage key/path. `getLoadableCheckpointForAnalysisObject`
finds the **single** durable checkpoint for the object — `artifact_type` `checkpoint`,
`storage_kind` `local_internal`, same project scope, linked via `result_analysis_object_id`,
with a safe internal key + checksum + size. **Zero** candidates → `NO_CHECKPOINT_ARTIFACT`;
**more than one** → `AMBIGUOUS_CHECKPOINT` (a **deterministic-reject** policy — the normal
flow produces exactly one checkpoint per result object, so more than one is anomalous and
refused rather than guessed). The bridge body is rebuilt from the **server-selected**
internal key + expected checksum/size only; the R endpoint confines the key with
`validate_path` and re-verifies the checksum before deserializing the RDS.

### Live R state behavior

The load **mutates** live R state — that is its purpose — but only the **owner's canonical
object key**. The R endpoint reassigns `global_obj`/`raw_obj` for the request's
`X-Object-ID` session, and the postroute hook persists **exactly that key**, so no other
user's or object's live state is touched. Live R state remains private and user/object-keyed.

### What it creates (and does not)

On success the handler records **one** metadata-only `checkpoint_load` summary artifact
(`scientific_output: false`, `live_state_mutation: true`; source object id, source
checkpoint artifact id, the already-public checksum/size, a sanitized loaded-object
summary, runtime versions). It creates **no** new analysis object, **no** lineage edge,
and **no** checkpoint artifact — it reattaches an existing one. The internal storage key,
R state key, raw path, matrices, cell/gene tables, and embeddings are never logged or
placed in metadata. On R failure / `loaded:false` / missing/ambiguous checkpoint /
cancellation / claim loss, **no** successful load artifact is created, and the claim guard
prevents two workers from duplicating one. There is **no download, no object storage, no
generated script, and no reproducibility bundle** here.

## DEG / pathway enrichment / CellChat audit

These exist in `r-backend/plumber.R` but are **deliberately not integrated** in this
branch (no new job type, no bridge op, no handler). They are documented here so the
branch stays honest about what already exists.

| Workflow | Endpoint | State | Reusability | Likely future job type |
| --- | --- | --- | --- | --- |
| **DEG** | `GET /deg` | Real: `FindAllMarkers(only.pos, min.pct=0.25, logfc.threshold=0.25)` + top-5/cluster heatmap via `AverageExpression`. Returns large marker + heatmap tables. | Reusable logic; needs wrapping (bounded/sanitized summary + artifact instead of returning full tables) and a results artifact model. | `deg.find_markers.v1` |
| **Pathway enrichment** | `GET /enrichment` | Real: clusterProfiler ORA (GO/KEGG), species auto-detection. Depends on optional Bioconductor packages (`clusterProfiler`, org dbs). | Reusable but **experimental**: optional heavy deps, must degrade safely when absent; needs the DEG step as input. | `enrichment.ora.v1` |
| **CellChat** | `POST /cellchat-infer` (real); `GET /cellchat` (mock — returns `WNT` placeholder) | `/cellchat-infer` is real CellChat v2 inference (label remapping, `requireNamespace` guard). `/cellchat` is a stub. | `/cellchat-infer` reusable but **experimental** (optional `CellChat` GitHub dep, long-running, large output). The `/cellchat` stub should not be wrapped. | `cellchat.infer.v1` |

Wrapping any of these later should follow the same pattern as `pbmc.pipeline.v1`:
server-side param allowlist, server-derived object context, ownership gate before R,
mutation on a copy, sanitized bounded summary, durable result object + artifacts, and a
single allowlisted bridge operation per workflow. They must not be wrapped until each
can be made fully safe and tested.

## Known limitations / follow-ups

- **Re-attaching** a completed checkpoint as live, inspectable R state under the object's
  canonical state key is implemented as the owner-only `checkpoint.load.v1` worker job
  (see *Checkpoint load / reattach* above). Still **owner-only** in v1 — a collaborative
  checkpoint clone/fork/load (a co-member loading another user's checkpoint into their own
  live session) is a future user-workspace/session-ownership design, not implemented here.
- No public **download** of the checkpoint file (by design).
- **Provenance** is recorded via artifact/result metadata + durable job logs (resolved
  params, summary, versions). A dedicated claim-guarded provenance helper for worker
  writes is a follow-up; the role-checked `createProjectProvenance` path was not wired
  into the worker to keep the success path idempotent and claim-guarded.
- Cancellation is cooperative/status-level only; it does not kill in-flight R work.
- DEG / pathway enrichment / CellChat remain unintegrated (see audit above).
