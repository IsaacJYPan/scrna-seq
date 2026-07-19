# Architecture & Current State

This is the curated, tracked architecture reference for the scRNA-seq Workbench.
It is the authoritative map of what is actually wired up today. `README.md` is the
short entry point; this file holds the detailed status table and boundary policies.

Keep this file honest: when a subsystem moves between backend-only and UI-wired,
update the table below in the same change.

## Runtime shape

```text
Browser (React/Vite)
  -> Express API (auth, authorization, DB, uploads, R proxy) --+
                                                               +-> private R Plumber/Seurat service
Standalone job worker -> Postgres queue + shared storage ------+
```

Express is the authentication and authorization boundary. The R backend trusts
only server-injected headers such as `X-API-Token` and server-derived
`X-Object-ID`; it must not be exposed directly to users or the public network.
The supported v1 topology has exactly one standalone worker slot and one private
R service shared with the web proxy. This keeps current live-R state semantics
intact; it is not support for parallel heavy-R replicas.

## Implemented vs UI-wired

The backend has moved ahead of the React UI. Several subsystems are fully
implemented and tested at the API/DB layer but are **not yet surfaced in the
app**. This table is the authoritative, honest map so future work does not
confuse "implemented and tested" with "usable in the UI".

Status legend:

- **UI-wired** — reachable and used through the React app today.
- **backend-only** — implemented and tested in Express/Postgres (and covered by
  CI backend tests), but no React UI surfaces it yet.
- **legacy/prototype** — older path still present; kept for now, not the
  intended durable product workflow.
- **not implemented** — intentionally out of scope in the current code.

| Subsystem | Status | Notes |
| --- | --- | --- |
| Auth / logout | UI-wired (cookie-only + versioned revocation) | A signed HttpOnly session cookie is the only authentication transport; bearer headers are ignored and pre-upgrade localStorage credentials are purged. Session claims contain only a bounded user ID, database-backed session version, deployment epoch, and times. Every authenticated request re-reads the user/session version. Logout atomically increments it and revokes all of that user's cookies; failure is 503 rather than false success. An already-expired cookie is cleared locally so the login screen remains reachable without claiming other sessions were revoked. Production registration is operator-only; stdin-only account and platform-capability mutations record audit events, and password reset revokes sessions. SameSite plus allowed-origin checks protect mutations, and the browser sends an explicit first-party CSRF header on every `/api/r` request because legacy GET operations can mutate R state. |
| Organizations / projects | UI-wired | A personal org/project is auto-created for the live-load flow. |
| Project members / RBAC | UI-wired | Collaborators lists project members for every role and lets owners/admins add existing users, change permitted roles, and remove permitted members. Owner-only owner changes, last-owner protection, non-member 404s, insufficient-role 403s, and server-controlled identities remain backend enforced. This is immediate account membership, not an invitation-token/delivery workflow. |
| Project-scoped datasets | UI-wired (narrow Seurat path) | The Pipeline Manager Seurat panel lists/uploads `tenx_h5` datasets for one supported workflow. General dataset management remains absent. New uploads use server-owned project storage keys plus SHA-256 checksums, and public responses omit internal storage. |
| DB-backed analysis objects (`ao_*`) | UI-wired | Created/selected via the workspace; authoritative object identity. |
| Live R object state | UI-wired | Private, transient, keyed by server-derived user/object state. |
| Pipeline Manager / pipeline manifests | UI-wired (trusted declarative registry) | Every project member may list approved global manifests and select one for their own user/project pair. Publication is global and requires the server-managed `pipeline_registry.publish` platform capability; project owner/admin/analyst roles do not grant it. Manifests compose only code-shipped modules from the shared frontend/backend contract. The UI renders declared parameter/result templates as a disabled preview, not a generic execution form. Legacy project/user definitions remain stored but quarantined, and their selections safely fall back to the built-in pipeline. |
| QC / Normalize / PCA / Cluster / UMAP / plots | UI-wired | Run through the private-live-R compatibility proxy. Production uses an exact method/path allowlist, one global slot, rate/deadline/body/response limits, bounded route parameters/results, QC sampling, plot budgets, an explicit outbound-header allowlist, JSON-only upstream responses, and response path/runtime-field sanitization. |
| DEG (differential expression) | UI-wired (durable worker path) | The primary DEG UI creates project-scoped `deg.find_markers.v1` jobs and reads job status, logs, and bounded `deg_summary` artifact metadata. It does not call legacy `/api/r/deg` for the main workflow. See "DEG paths" below. |
| Durable DEG worker (`deg.find_markers.v1`) | UI-wired | Durable, allowlisted worker job + `r.deg.find_markers.v1` bridge op. The DEG tab launches this job and displays sanitized summary metadata only; full marker tables remain internal and are not downloadable. |
| Durable Seurat pipeline worker (`seurat.pipeline.v1`) | UI-wired (10x HDF5 only) | Pipeline Manager can upload/select one `tenx_h5` dataset, create/reuse a raw dataset analysis object, launch a durable Seurat preprocessing job, show logs/status/safe summary metadata, and hand the result to checkpoint load or DEG. See "Seurat pipeline path" below. |
| Durable jobs | UI-wired (metadata + selected launches) | Durable ownership-scoped job records + API are shown in Jobs & Artifacts. The DEG, Pathway Enrichment, and CellChat tabs can create `deg.find_markers.v1`, `enrichment.gsea.v1`, and `cellchat.infer.v1` respectively; Pipeline Manager can create `seurat.pipeline.v1` and result `checkpoint.load.v1`; Jobs & Artifacts can create `checkpoint.fork.v1` when an object has exactly one available, local, loadable checkpoint. General job launch, cancel, and retry flows are not generally UI-wired. |
| Standalone job worker | backend-wired (one-slot topology) | `worker.js` is the queue consumer; Express no longer starts an in-process worker. `npm run dev` supervises Vite, Express, one local R service, and one standalone worker; `npm run dev:no-worker` omits the worker. Claims use Postgres leases and `FOR UPDATE SKIP LOCKED`; a Postgres advisory singleton plus `JOB_WORKER_CONCURRENCY=1` enforce the supported one-process topology using the same private R service as Express. Process tests prove second-entrypoint refusal and lease recovery, not parallel heavy-R execution. Private `/livez` and `/readyz` endpoints expose process/readiness state. |
| PBMC pipeline worker (`pbmc.pipeline.v1`) | backend-only | Copy-on-modify Seurat preprocessing as a durable job; not wired into the UI. |
| Checkpoint artifacts | UI-wired (metadata + reattach/fork actions) | Immutable result checkpoint metadata per successful job can be listed. Pipeline Manager can request owner-only reattach through `checkpoint.load.v1`; project writers can request a private collaborator fork through `checkpoint.fork.v1`; there is still no download route. |
| Checkpoint load worker (`checkpoint.load.v1`) | UI-wired (Seurat result action) | Owner-only reattach of a server-selected checkpoint into live R. UI coverage is limited to the Seurat pipeline result panel; it is not a general checkpoint browser/launcher. |
| Checkpoint fork worker (`checkpoint.fork.v1`) | UI-wired (controlled checkpoint action) | When a project object has exactly one available `local_internal` checkpoint, a project writer may load that server-selected checkpoint into a new analysis object and private live R key owned by the writer. Ambiguous or unloadable checkpoint sets are rejected. The immutable source object/checkpoint remain unchanged; the child object and lineage edge record the source object, exact checkpoint artifact, fork job, and creating member. It never attaches the source owner's live state. |
| Job artifacts (metadata) | UI-wired (read-only metadata) | Read-only, path/storage-key stripped from responses; no download route. Jobs & Artifacts renders sanitized metadata only. |
| Analysis-object lineage DAG | UI-wired (read-only summary) | Edge model + parents/children/lineage read routes are surfaced as a bounded summary in Jobs & Artifacts. Mutations remain server/worker-driven. |
| Provenance / figures / cache | UI-wired with production limits | Older `/api/db/*` routes still back the live gallery/cache path. Jobs & Artifacts also shows project-scoped provenance and figure metadata read-only. Production keeps bounded figure preview but disables legacy server-file gallery save because its R export path is outside the durable artifact contract. |
| Runtime check / object inspect workers | backend-only | Read-only, metadata-only bridge operations. |
| Default visual theme | UI-wired | The React shell is light-first by default with the existing dark toggle retained. |
| Ranked pathway enrichment (`enrichment.gsea.v1`) | UI-wired (local image and real-R smoke verified) | The active Pathway Enrichment page launches one cluster/identity-versus-rest ranked GO Biological Process job, polls status/logs, and displays a bounded `enrichment_summary`. The full `enrichment_results` CSV stays private. The R 4.5.3 image build and real-R smoke pass on this worktree; deployed browser acceptance remains a release gate. |
| CellChat / cell-cell communication (`cellchat.infer.v1`) | UI-wired (narrow durable single-context path) | The CellChat tab requires an owner-attached live R object and explicit fixed choices for grouping (`seurat_clusters` or current identities), species, CellChatDB category, cell caps, and `single_context` intent. It launches an allowlisted worker job, polls its durable status, and shows a bounded sanitized candidate summary. The complete candidate CSV is `local_internal`; its metadata-only `cellchat_summary` companion has no storage path/key or public download. Raw group labels are replaced with opaque `Group N` identifiers in durable outputs; an owner-local key is read only from the currently attached private R object. This is candidate inference, not evidence of physical contact, causality, or a condition comparison. Real-R smoke and receipt-interoperability checks are separate from the mocked API-transport Playwright UI check; deployed browser/backend/R acceptance remains a release gate. |
| Cell annotation | not implemented (product) | UI placeholder only. A legacy authenticated R endpoint may still exist (see below). |
| Custom Script / arbitrary R execution | not implemented | Out of scope; no arbitrary-R endpoint. |
| Reports / generated R scripts | not implemented | No supported report or script-export surface. Legacy live-R provenance script preview is copy-only and not a complete reproducibility export. |
| Artifact downloads | not implemented | No public download route; responses never expose storage paths/keys. |
| Object storage | not implemented | Local filesystem provider only; no external object storage. |
| Secure cookie sessions | backend-wired | Production uses a host-only `__Host-` HttpOnly + Secure + SameSite cookie. The frontend restores only through `/api/auth/session`; public auth JSON never contains a token/session version. Logout is revoke-all through `users.session_version`; secret or deployment-epoch rotation invalidates all sessions, and malformed/duplicate cookies fail closed. Globally bounded asynchronous PBKDF2 work prevents authentication from blocking the event loop. |
| Postgres database runtime | backend-wired | `backend/pgDatabase.js` + `backend/pg/schema.sql` are the app metadata runtime for users, projects/members, datasets, analysis objects, project jobs/logs/artifacts, provenance, figures/cache, and lineage. See "Database backend" below. |
| Shared project live R state | not implemented | Collaboration is via durable metadata, never a shared live R session. |
| Single-host deployment | backend-wired (supported conservative topology) | `deploy/compose.single-host.yml` packages one web, one worker, one private R, Postgres, and on-demand operations in a shared private namespace with loopback-only ingress, non-root/read-only containers, resource limits, health checks, and drain ordering. Postgres advisory locks refuse unsupported second web/worker instances. It is not HA or a multi-host topology. |
| Backup / restore | backend-wired (offline operations) | A controlled operations image creates a custom Postgres dump plus exact SHA-256/size inventories of `STORAGE_ROOT` and `VAULT_ROOT`. Restore requires an empty DB, new/empty roots, and a new deployment epoch; it stages files, restores in one DB transaction, cancels/de-claims restored queued/running jobs, and re-inventories before success. CI runs a real pg_dump/pg_restore/reference/security-delta/table-fingerprint drill. See `docs/deployment.md`. |

## Trusted declarative pipeline registry

The pipeline registry is a presentation and workflow-composition boundary, not a
code-loading boundary:

- `platform_capabilities` stores the narrow `pipeline_registry.publish`
  capability independently of project RBAC. It is granted, revoked, or inspected
  only by an operator using
  `npm run platform-developer -- <grant|revoke|status> <email>`. No browser route
  grants platform capability.
- Publishing uses the global authenticated registry endpoint. Project roles,
  including project owner, admin, and analyst, cannot publish. Ordinary project
  members may list approved global definitions and keep an independent active
  selection for each user/project pair.
- A trusted stored definition has `project_id = NULL`, visibility `platform`, a
  server-generated row id, and a unique validated manifest id. Older `user` and
  `project` definitions are retained for rollback/history but excluded from
  listing and lookup. A selection that points to an unavailable or legacy row
  returns the built-in definition with an unavailable-selection signal; it never
  returns the legacy manifest.
- Every stored platform manifest is parsed and validated again before it reaches
  a public response. Invalid or corrupt rows fail closed. Publication is bounded
  to 64 KiB, and at most 200 platform definitions may exist.
- `shared/pipelineRegistryContract.json` is the data-only frontend/backend source
  for registered module keys, routes, component keys, parameter templates,
  result views, artifact types, and executable job types. The manifest supplies
  labels and a bounded declarative schema; it cannot override those registered
  bindings.
- The Pipeline Manager renders a disabled, read-only preview of allowed
  parameter controls and result cards. Preview controls never submit data or
  launch a job. There is no generic manifest executor.
- The registered manifest modules that declare durable executable jobs are
  differential expression (`deg.find_markers.v1`), ranked pathway enrichment
  (`enrichment.gsea.v1`), and the narrow CellChat candidate-inference workflow
  (`cellchat.infer.v1`). Other registered sidebar modules are views over
  existing application behavior; they do not claim nonexistent per-step worker
  handlers or artifact types. The separate, code-shipped default Seurat panel
  still owns the narrow `seurat.pipeline.v1` launch.

Publishing a manifest cannot add JavaScript, React components, R code, R
packages, R endpoints, filesystem paths, storage keys, URLs, or a new worker
handler. New executable modules still require a reviewed application release.
Arbitrary R in a future BYOC design remains a separate high-risk capability that
would require per-job container or VM isolation, strict input/output mounts,
network and secret restrictions, and resource quotas.

## DEG paths (two implementations)

There are currently two DEG implementations, but the React DEG page now uses the
durable worker path as its primary workflow:

- **UI today:** the React DEG page creates a project-scoped
  `deg.find_markers.v1` job, polls project job status/logs, and renders only
  sanitized `deg_summary` artifact metadata. Full raw marker tables are stored as
  internal `deg_markers` artifacts and are not downloadable.
- **Legacy/dev path:** `/api/r/deg` remains reachable only outside production
  for temporary legacy/development compatibility. Production blocks it before
  R contact. It is not the main DEG UI workflow.

Neither path is removed. The DEG UI migration does not add public downloads,
generated reports/scripts, or shared live R state; CellChat has its separate,
narrow durable path below.

## Ranked pathway-enrichment path

The active pathway workflow is a fixed, durable `enrichment.gsea.v1` job. It is
not the legacy synchronous `/api/r/enrichment` prototype.

- **Scientific scope:** one explicit cluster or current identity group is
  compared with the remaining cells using a fixed two-sided Wilcoxon marker
  calculation with no significance pre-filter. The complete testable fold-change
  ranking is mapped from gene symbols to Entrez identifiers and passed to local
  GO Biological Process GSEA. Species is an explicit human/mouse choice; v1 does
  not guess species from capitalization and does not call a remote pathway API.
  A visible `maxCellsPerIdent` limit is always finite (10,000 by default), and
  the recorded seed makes downsampling and tied-score ordering repeatable.
- **Interpretation:** this is descriptive cluster-versus-rest enrichment. It does
  not prove pathway activation, and it is not a sample-aware treated-versus-control
  test. Condition claims require durable donor/sample/condition metadata and a
  pseudobulk or other replicate-aware comparison that is not implemented here.
- **Execution boundary:** the creator must own the selected live R object. The
  worker validates the exact parameter allowlist, derives the private object key,
  allocates the output key, and calls only `r.enrichment.gsea.v1` at
  `POST /object/enrichment-gsea`. Express blocks that endpoint from the public R
  proxy before R contact. The R operation works on a local copy and restores
  identities/assay; it never publishes a changed live object.
- **Outputs and recovery:** R atomically writes a private CSV plus a signed,
  job/project/object/output-bound completion receipt. The database atomically
  records one `local_internal` `enrichment_results` artifact and one bounded
  metadata-only `enrichment_summary`; no result analysis object or lineage edge
  is created. Summary previews are capped at 25 pathways, complete leading-edge
  genes remain private, and public artifact projections omit storage keys. The
  signed summary records R, Seurat, GSEA, annotation, GO, and organism-database
  versions for result-level software provenance.
- **Deployment dependency:** `clusterProfiler`, `fgsea`, `AnnotationDbi`,
  `org.Hs.eg.db`, `org.Mm.eg.db`, and `GO.db` are mandatory in the production R
  image and audited in CI. The R 4.5.3 image and real-R known-shape smoke pass
  on this worktree; deployed database/worker/browser acceptance remains a
  release gate.

## CellChat candidate-inference path

The active CellChat workflow is a fixed, durable `cellchat.infer.v1` job. It is
not the legacy synchronous `/api/r/cellchat` or `/api/r/cellchat-infer` path.

- **Scientific scope:** the user must explicitly choose `seurat_clusters` or
  current Seurat identities, human or mouse, one reviewed CellChatDB category,
  and the only supported intent, `single_context`. The worker accepts no
  arbitrary metadata column, condition/comparison definition, R code, endpoint,
  path, or state key. It requires two through 32 populated groups and applies
  validated, recorded per-group and total-cell bounds with deterministic sampling.
  The RNA assay is fixed to normalized `RNA` data. The helper extracts only the
  reviewed CellChatDB signaling-gene layer, rather than cloning a multiomic
  Seurat subset; it rejects a changed resource over 2,000 signaling features or
  an estimated dense input over 128 MiB.
- **Interpretation:** CellChat predicts ligand-receptor signaling candidates
  from expression and a curated resource; it does not observe communication,
  establish physical contact, or establish causality. It is deliberately not a
  treated-versus-control, patient-versus-patient, or other sample-aware
  comparison. Because each eligible group may be capped, probabilities describe
  capped per-group expression and do not encode original population abundance.
  The method/resource choice is recorded in the sanitized summary. This matches
  the hypothesis-generating framing in the
  [CellChat paper](https://www.nature.com/articles/s41467-021-21246-9) and the
  method/resource sensitivity demonstrated by the
  [multi-method comparison](https://www.nature.com/articles/s41467-022-30755-0).
- **Execution boundary:** creation and the worker both require the selected
  live R object's owner, so a project collaborator cannot queue work against a
  different member's private R state. The worker rechecks ownership, derives
  its private R state key, validates the
  exact parameter allowlist, allocates the output key, and calls only
  `r.cellchat.infer.v1` at `POST /object/cellchat-infer`. The R helper works on
  a local subset and preserves the source object's identities, assay, metadata,
  and process RNG state. Express blocks the worker endpoint from the public R
  proxy before R contact.
- **Outputs and privacy:** R atomically writes the complete candidate table and
  a signed job/project/object/output-bound completion receipt. The worker
  atomically records one private `local_internal` `cellchat_results` CSV and one
  bounded metadata-only `cellchat_summary`; it creates no result analysis object
  or lineage edge. Public projections omit storage keys, paths, receipt fields,
  state keys, and raw group labels. Durable summaries and the private CSV use
  opaque `Group N` labels, including receipt recovery; both Node and the UI
  reject any other group identifier. The private CSV is streamed from bounded
  CellChat array slices and retains at most 50,000 globally ranked interactions.
  The owner UI may request a short-lived mapping from
  its attached private R object, but that mapping is neither persisted with the
  job/artifact nor a historical label guarantee if identities change later. No
  general byte-download route exists.
- **Dependencies and evidence:** the production R image requires `NMF`, the
  exact reviewed GitHub `presto` dependency, Bioconductor `BiocNeighbors`, and
  pinned CellChat 2.1.2.
  `test:cellchat-inference` runs the real R helper over a
  synthetic Seurat object, including deterministic sampling, barcode/group
  alignment, non-mutation, opaque durable labels, private CSV/receipt output,
  bounded summary checks, direct equivalence with CellChat's native extraction,
  and a dense 50,000-row-cap fixture. `test:cellchat-receipt-interop` verifies
  that Node can authenticate and reconstruct the R-written receipt.
  `test:cellchat-worker-pipeline` runs real Postgres, standalone workers, and
  spawned R/CellChat, deliberately loses the first response after receipt write,
  and proves receipt-only recovery does not execute CellChat twice. Those are
  still not a full deployed browser/Express/Postgres/worker acceptance run.
  The focused Playwright flow uses a real React browser with mocked project/job
  transport and therefore proves UI contract/rendering only.

## Downstream-analysis roadmap and evidence

There is no single downstream checklist that fits every single-cell study. The
next features are ordered around recurring analyses in strong publications and
around what the app can report without inventing experimental design:

1. **Ranked pathway enrichment (implemented):** use the complete testable gene
   ranking, not only a short list of statistically significant genes. This
   follows the core design of [Gene Set Enrichment Analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC1239896/).
2. **Sample-aware condition comparisons (next metadata foundation):** treated
   versus control claims must use biological samples or donors as the units of
   replication. The app needs durable sample, donor, and condition fields before
   it can offer pseudobulk differential expression or condition-level pathway
   claims. This guardrail follows the false-positive findings in
   [Squair et al.](https://www.nature.com/articles/s41467-021-25960-2).
3. **Cell-to-cell communication (implemented narrow slice):** CellChat now
   provides a fixed one-context candidate-inference workflow. Cross-condition
   CellChat comparisons remain out of scope until the sample/donor/condition
   model above exists; the implementation must not silently pool cells into a
   condition claim.
4. **Differential abundance, trajectory, and regulatory activity:** add these
   only after their required sample design, time/order, or lineage assumptions
   can be represented explicitly in project metadata and the UI.

CellChat is not silently configured from cluster names, and its durable job
records the explicit scientific and capacity choices. It remains deliberately
separate from the future sample-aware comparison foundation.

## Seurat pipeline path

The first supported end-to-end local/dev pipeline is intentionally narrow:

- **Supported input:** one uploaded 10x Genomics filtered feature-barcode matrix
  HDF5 file, stored as dataset `fileType: "tenx_h5"` under a server-owned
  project storage key. Matrix Market folders/zips,
  H5AD, H5Seurat, RDS, multi-sample batches, and public downloads are not part of
  this v1 path.
- **UI workflow:** Pipeline Manager lists/uploads `tenx_h5` datasets, creates or
  reuses a DB-backed raw dataset analysis object with the same `datasetId`,
  launches a project-scoped `seurat.pipeline.v1` job, shows job status/logs and
  sanitized summary/checkpoint metadata, then can launch `checkpoint.load.v1` to
  reattach the result object into the owner's private live R state before
  downstream DEG.
- **R steps:** `Read10X_h5`, `CreateSeuratObject`, optional QC filtering,
  `NormalizeData` or `SCTransform`, variable features, scaling, PCA, neighbors,
  clusters, and UMAP. Parameter names are strictly allowlisted by
  `backend/seuratPipeline.js` before job creation and again before R contact.
- **Outputs:** a result `seurat` analysis object parented to the raw dataset
  object, one internal `checkpoint` artifact, one metadata-only
  `pipeline_summary` artifact, a lineage edge, and a job result link. Public API
  responses do not expose dataset storage keys, checkpoint storage keys, local
  paths, R state keys, matrices, embeddings, cell rows, or gene tables.
- **Worker boundary:** Express blocks `/api/r/object/seurat-pipeline` from the
  public R proxy before R contact. The endpoint is reachable only through the
  allowlisted trusted worker bridge, which reconstructs the body from trusted DB
  rows and server-allocated checkpoint keys. Worker R responses have an explicit
  byte ceiling and total wall-clock deadline.
- **Module boundary:** The default Seurat workflow is represented as a
  declarative pipeline manifest whose tabs map to code-shipped frontend module
  templates. The narrow default Pipeline Manager panel, rather than a generic
  manifest executor, owns the full `seurat.pipeline.v1` worker launch. Separately
  queued preprocessing modules remain future work. Approved manifests cannot
  introduce arbitrary code, packages, worker handlers, or backend endpoints.

This is local/dev pipeline evidence, not hosted-service production readiness.
There is no object storage, no public download route, no general dataset
manager, and no live R state shared across project
members.

## Hidden/disabled features vs reachable R endpoints

CellChat is UI-wired only through the narrow durable
`cellchat.infer.v1` workflow described above. Cell annotation remains a UI
placeholder. Ranked pathway enrichment is likewise integrated only through its
durable `enrichment.gsea.v1` workflow. Their worker-only inference endpoints are
not public APIs.

The one CellChat-specific public-proxy route is the reviewed,
owner-scoped `GET /api/r/cellchat-group-map`: after a result is displayed, it
returns the current attached owner's mapping from opaque `Group N` labels to the
fixed selected grouping (`seurat_clusters` or `ident`). It accepts neither an
arbitrary metadata field nor a result/storage path, and the UI keeps the result
in memory rather than persisting it with project metadata. It does not make a
collaborator's private live R state visible or reconstruct an historical mapping
after identities change.

Legacy authenticated endpoints remain reachable only outside production for
development compatibility, including `/api/r/cellchat`,
`/api/r/cellchat-infer`, `/api/r/enrichment`, `/api/r/annotate-clusters`, and
`/api/r/deg`. Production is fail-closed with an exact method/path allowlist and
blocks those legacy routes before R contact.

The legacy synchronous vault loaders (`/load-local-10x`, `/load-multi-10x`, and
`/load-h5ad`) are also blocked in production because their aggregate dimensions
and conversion memory are unknown until after expensive file work begins. Use the
project-scoped dataset upload plus `seurat.pipeline.v1` durable job for the
currently supported 10X HDF5 path. The legacy loaders remain available only for
explicit local/development compatibility.

The legacy `/csv-columns`, `/add-metadata`, and `/subset` live-state routes are
likewise blocked in production. The CSV routes can inspect or attach an unbounded
user file directly to a live Seurat object; subset duplicates live state and can write a client-selected vault file
outside the durable artifact contract. They remain local/development compatibility
only until queued replacements own bounded inputs, outputs, and storage accounting.
Synchronous `/integrate` is also production-blocked. Even with object and dense-value
ceilings, CCA anchor search grows across batch pairs and a proxy timeout cannot stop
work already running in the singleton R service. Integration needs a durable,
resource-isolated job path before production exposure.

The public non-secret deployment policy keeps the React shell aligned with these
boundaries and fails closed if the policy cannot be loaded. Production's
Load/Attach modal retains the bounded PBMC demo and links to Pipeline Manager,
but hides local-directory/RDS/H5AD loaders. Inspect hides CSV import and live
subset while retaining bounded in-object value mapping; the sidebar disables
synchronous Integration; figure panels retain preview but disable legacy
server-file save.

By contrast, the internal worker-only R endpoints
(`/api/r/object/pbmc-pipeline`, `/api/r/object/checkpoint-load`,
`/api/r/object/deg-find-markers`, `/api/r/object/enrichment-gsea`,
`/api/r/object/cellchat-infer`, `/api/r/object/seurat-pipeline`, and
`/api/r/object/inspect`, plus `/internal/worker-readiness`) are
**blocked** from the public proxy before any R contact (404, no existence leak);
they run only through the trusted standalone-worker bridge/readiness client. The current policy is pinned
by `backend/r-proxy-policy.test.js`.

## RDS loading is a trusted-input boundary

The R backend has legacy `.rds` load/restore endpoints, but they are fail-closed
by default at Express and again in R. **RDS
deserialization can execute arbitrary R code.** Set `ALLOW_TRUSTED_RDS_LOAD=true`
only for trusted local/dev inputs; production ignores the override and always
blocks both public routes. Outside production the route remains owner-scoped and
path-validated (confined to the per-user vault), but it is not safe for
untrusted uploads until stronger sandbox/container isolation exists. Worker
checkpoint loading is a separate internal path for server-created checkpoints.

## Standalone worker topology

Branch 5 separates durable queue consumption from the web process without
claiming that the existing live-R architecture can scale horizontally:

- `server.js` serves the API and either owns one loopback R child for local use
  or connects to a separately managed private R service. It never starts a job
  worker.
- `worker.js` is a separate trusted process with direct Postgres access, the
  shared local-filesystem provider, and the same private R URL/token as Express.
  Its supported concurrency is exactly one in-flight job.
- A session-level Postgres advisory lock refuses a second standalone entrypoint.
  An active unexpired claim prevents replacement startup; loss of the lock after
  startup is fatal and triggers a controlled nonzero drain/exit. Every claim
  transaction also takes a distinct advisory gate and refuses to claim while
  any unexpired running job exists. This closes the interval between a lost
  session lock and process shutdown, so the supported topology still admits at
  most one live job.
- `npm run dev` supervises Vite, Express, the local owned R child, and the
  standalone worker with one ephemeral shared R token. `npm run dev:no-worker`
  starts the UI/API/R stack only. A deployed standalone worker requires
  `R_RUNTIME_MODE=external` and an explicit production `R_API_TOKEN` encoded as 64 lowercase hexadecimal
  characters.
- The private R URL must be loopback, a private IP literal, or an exact hostname
  in `R_BACKEND_ALLOWED_HOSTS`. URL credentials, query strings, fragments, and
  path prefixes are rejected. The R token is an internal service credential,
  not browser authentication, and must never be exposed publicly.
- A web-owned R child receives a narrow environment allowlist. Database/session
  credentials, cloud credentials, and unrelated process secrets are not copied
  into the scientific runtime.
- Worker readiness requires Postgres, authenticated R, enough admitted free
  memory, and a fresh nonce-backed storage challenge visible through R. Express, the worker,
  and R must use the same persistent `STORAGE_ROOT`; cross-host local disks are
  unsupported. `/livez` only reports process life, while `/readyz` also goes
  non-ready before drain and whenever dependency admission fails.
- The memory threshold is claim admission, not a hard per-job limit. Real
  deployments still need container/VM CPU, RAM, disk, and network controls.
- On shutdown the worker stops accepting claims, remains alive to heartbeat and
  drain the active tick, then closes health and database resources. The default
  630-second drain budget exceeds the current 600-second maximum R call;
  orchestrator termination grace must exceed the worker drain budget.
- Cancellation is cooperative for the shared R process. A canceled running job
  cannot publish durable output through its invalidated claim, but the underlying
  R call may continue until it returns. Deterministic file output is removed when
  cancellation authoritatively wins; canceled checkpoint load/fork state remains
  owner-private and ephemeral until bounded LRU eviction or R restart. Immediate
  compute termination requires a future isolated per-job runtime.
- PBMC, Seurat, checkpoint load/fork, DEG, ranked enrichment, and CellChat
  candidate-inference jobs receive at most two execution
  attempts, but a claim-guarded dispatch marker prevents a crashed worker from
  issuing the same side-effecting R request twice. R atomically writes a private,
  HMAC-signed, job/project/type/input/output-bound completion receipt after its
  deterministic file or live-state mutation. A later recovery-only claim adopts
  that exact receipt or exact committed DB output without another R call. The
  authenticated readiness gate against the supported singleton synchronous R
  process is the execution barrier before missing-receipt cleanup; without that
  proof recovery remains in no-R observation. Recovery is allowed after creator
  removal/demotion because it cannot invoke a handler. Partial or integrity-
  mismatched output fails closed, and an ambiguous DB acknowledgement is resolved
  by re-reading the exact committed output before cleanup.
- The private R session cache authenticates before key lookup, accepts only the
  canonical server-derived user/object key shape, retains no empty keys, and
  deterministically evicts least-recently-used entries to enforce global/per-user
  count and estimated-object-byte budgets. Eviction never grants shared project
  live state; users reattach their own durable checkpoints as needed.
- An optional registered job-type capability filter is applied atomically during
  claim. This prepares for reviewed worker pools, but running multiple heavy-R
  workers is not supported while jobs depend on one process-local R state store.

The standalone worker remains a trusted first-party deployment component: it has
application database credentials and the internal R capability. It is not a
safe outbound BYOC agent and it does not execute uploaded/customer R code.
Arbitrary R, package installation, per-job containers or microVMs, hard resource
enforcement, multi-host autoscaling, and a narrow remote execution broker remain
explicitly deferred.

## Database backend

The app runtime is Postgres-only.

- **Runtime today:** `server.js` loads `backend/pgDatabase.js`; startup refuses
  to run without `DATABASE_URL` or `PG*` connection settings.
- **Schema/data layer:** `backend/pg/schema.sql` is the durable schema for
  server-owned identity, role/scope columns, job state-machine + worker
  coordination, artifact immutability, provenance/figures/cache, and lineage DAG.
  `backend/pgDatabase.js` is the async `pg` data layer for users, platform
  capabilities, the trusted pipeline registry, orgs/projects/members, datasets,
  analysis objects, project jobs/logs/artifacts, provenance, figures/cache, and
  lineage. Public projections strip claim tokens, worker internals, storage
  keys/URIs, object hashes, publisher identity, and raw paths.
- **Backend selection:** `DATABASE_BACKEND` is accepted for readable summaries but
  always resolves to `postgres`; SQLite is no longer a runtime option.
- **Schema init:** `npm run init:postgres` applies `schema.sql` idempotently
  (`DATABASE_URL` or `PG*` env). Existing SQLite dev data is not migrated; a
  fresh Postgres database starts empty and users/projects are re-created through
  the normal signup/create flows.
- **Local Postgres:** `docker compose up postgres` (localhost-only) or any local
  Postgres; then `DATABASE_URL=postgres://scrna:scrna@localhost:5432/scrna npm run init:postgres`.
- **Evidence:** `npm run test:backend` includes the config contract,
  real-Postgres database contract, and live Express runtime smoke test. The
  Postgres-specific tests skip when no database is configured, but the server
  itself does not.

## State & storage boundaries

- Browser auth is an **HttpOnly session cookie** and bearer transport has been
  removed. The frontend purges old bearer values and starts from
  `/api/auth/session`; JavaScript never receives the signed session. The token's
  database-backed version is checked on every request, and logout increments the
  version to revoke all outstanding sessions for that account. Project role and
  membership are still re-checked on every project-scoped request. CSRF for
  ordinary mutations is SameSite=Lax plus an allowed-origin check
  (`FRONTEND_ORIGIN`). The browser also sends `X-BenchOne-CSRF: 1` on every
  `/api/r` request because some legacy GET endpoints mutate state; cross-origin
  scripts cannot send that custom header without a successful CORS preflight.
  SameSite=Lax is intended for same-site/local deployments (API and frontend on
  the same origin). For cross-origin hosted deployments — API and frontend on
  different origins — cookie auth requires an explicit `COOKIE_SAMESITE=None` +
  `COOKIE_SECURE=true` configuration, a correct `FRONTEND_ORIGIN` allowlist, and
  HTTPS; config validation refuses `SameSite=None` without Secure cookies and,
  in production, refuses non-HTTPS frontend origins for cross-site cookies.
  Same-origin deployment is the supported Compose default.
- `backend/storage.js` is the active local-filesystem provider for new durable
  datasets, checkpoints, DEG tables, pathway-enrichment tables, and CellChat
  candidate tables. It uses server-owned keys shaped as
  `projects/<projectId>/<kind>/<id>/<file>` under `STORAGE_ROOT`. Writes are
  finalized atomically, checked by size and SHA-256, and blocked from following
  links outside the root. Keys are never client-supplied or returned publicly.
  Existing `vault/...` records remain readable; they are not silently rewritten.
  Production config rejects overlapping storage/vault roots and malformed upload
  limits. No external object storage and no public downloads exist.
- Backend projects, DB-backed analysis objects, jobs, artifacts, checkpoints,
  and lineage are the durable source of truth **at the API/DB layer**. Projects
  and analysis objects are active UI surfaces; jobs, artifacts, checkpoints, and
  lineage are visible as sanitized metadata in Jobs & Artifacts, which also
  exposes the narrow checkpoint-fork launch. The DEG, Pathway Enrichment, and
  CellChat tabs can launch `deg.find_markers.v1`, `enrichment.gsea.v1`, and
  `cellchat.infer.v1` worker jobs and read their sanitized summary artifacts.
  The Pipeline Manager Seurat panel can list/upload `tenx_h5`
  datasets for `seurat.pipeline.v1`, launch that job, and request checkpoint
  reattach for the result object. General dataset management, generic worker job
  launch/cancel/retry flows, and artifact downloads remain
  backend-only or absent (see the table above).
- localStorage may cache selected project/object IDs and UI preferences only; it
  is not authoritative for projects, analysis objects, lineage, jobs, roles, or
  checkpoints.
- Live R state is private, transient, and keyed by server-derived user/object
  state. Project metadata visibility does not grant live R access.
- Legacy `/api/analysis-objects*` and `/api/jobs*` compatibility routes expose
  only genuinely private, projectless resources. Project resources and legacy
  descendants that trace to project data stay behind project RBAC routes, so
  immutable creator metadata cannot become a post-removal access bypass.
  Receipt-backed PBMC/Seurat/checkpoint/DEG/enrichment/CellChat job types are rejected synchronously
  on `/api/jobs`; they require project-scoped durable storage and must use the
  project jobs API.
- The standalone worker is opt-in and allowlisted. Registered handlers include
  PBMC pipeline, dataset-backed Seurat pipeline, checkpoint load, checkpoint
  fork, DEG marker finding, ranked pathway enrichment, CellChat candidate
  inference, runtime check, and object inspection. The DEG, enrichment, and
  CellChat workflows are UI-wired for job launch/status/safe summary metadata;
  the Seurat pipeline UI is wired only for `tenx_h5` input plus result checkpoint reattach.
  PBMC pipeline, runtime check, and object inspect worker launches remain
  backend-only. Express never consumes the queue.
- Project authorization is checked when a job is created and revalidated under a
  project lock immediately before worker claim. Queued jobs owned by a removed
  member or a member demoted below analyst are canceled with a sanitized
  `PROJECT_ACCESS_REVOKED` error before handler/R contact. A job that was already
  running keeps its valid claim and may finish; its durable output/history remains
  project-scoped, while a removed member can no longer read the project. If that
  worker published an exact atomic output and crashed before terminal status,
  the next worker may only finalize that committed output; it cannot rerun R.
- There is no public artifact download surface, object storage, generated report
  export, arbitrary R execution, or shared project live R state.
- New local files survive application restarts when `STORAGE_ROOT` is persistent
  and shared correctly with Express, the worker, and R. Legacy records also
  require `VAULT_ROOT`.
  Metadata can outlive a missing file, and there is no startup reconciliation yet.
- R 4.5.x is the intended local development target; the Dockerfile pins R 4.5.3
  with Bioconductor 3.22. Report if R 4.6.x is detected.

## Testing & CI notes

- `npm run test:backend` runs the FULL backend suite (`backend/*.test.js`)
  against Postgres: config boundaries, the real `pgDatabase` contract, per-user
  isolation, cookie-only versioned auth/rate-limit/credentials, org/project RBAC,
  the trusted pipeline-registry capability/legacy-quarantine contract, datasets,
  analysis objects, the durable job-worker claim/lease/heartbeat contract,
  standalone runtime/process behavior, crash-output recovery,
  artifacts/checkpoints, the lineage DAG, the R-proxy
  ownership/policy/diagnostics gates, and the mocked-R pipeline worker handlers
  (including the CellChat handler/bridge contract).
  Every DB-backed suite resets the schema per test via `resetSchemaForTests()`
  and skips cleanly without `DATABASE_URL`; pure suites always run. (The SQLite-era
  schema-migration/backfill and `busy_timeout` tests were removed with the
  Postgres cutover — the Postgres schema ships every table from `pg/schema.sql`.)
  Durable jobs, artifacts/checkpoints, and lineage are implemented in the backend. The React UI now includes a
  Jobs & Artifacts / durable history surface for safe metadata visibility and
  controlled checkpoint forks; the DEG, Pathway Enrichment, and CellChat tabs
  launch `deg.find_markers.v1`, `enrichment.gsea.v1`, and
  `cellchat.infer.v1` jobs and read bounded summary metadata; and the Pipeline
  Manager Seurat panel launches the
  narrow `seurat.pipeline.v1` path with result checkpoint reattach. General job
  launching, artifact downloads, and lineage mutation are still not UI-wired. A
  passing backend suite means the API/DB contract holds - **not** that every
  backend feature is surfaced in the UI.
- `backend/standalone-worker-process.test.js` launches real child processes
  against real Postgres. It proves a second standalone entrypoint is refused,
  one supported process drains jobs sequentially, a crashed claim is recovered
  after lease expiry, and the stale claim capability remains invalid. Runtime tests separately pin readiness,
  one-slot admission, drain behavior, token/URL validation, R child secret
  exclusion, response limits/deadlines, and exact-output crash recovery.
- `npm run test:visual` is a **mocked** frontend visual smoke test: it renders
  the built UI with backend and R responses mocked in the browser. It checks
  rendering/layout and obvious UI regressions only, and is **not** integration
  or security evidence. It runs in CI.
- `npm run test:visual:db-flow` drives the DB-backed project/object UI flow with
  **all `/api/*` responses mocked** via Playwright route interception and a fake
  auth token. It requires a browser (Playwright/Chromium) + Vite, is **not run
  in CI**, and is best used as a **local pre-merge smoke test** for branches that
  change the project/object UI flow. It proves the UI *model* wiring (what the
  app requests and how it renders responses); it does **not** prove real
  backend, auth, ownership, or tenant isolation.
- `npm run test:cellchat-browser` is a focused **mocked-transport Playwright**
  test. It starts the actual React/Vite app and Chromium, but route-intercepts
  auth, project, object, job, artifact, and owner-local group-key responses. It
  verifies explicit scope selection, the exact durable job payload, sanitized
  bounded summary rendering, private-result messaging, and absence of console
  or request failures. It does **not** prove Express authorization, a worker
  claim, R ownership, storage, or CellChat computation.
- `npm run test:deployment:browser` is the real frontend deployment flow. It
  drives Chromium without route interception through the built React bundle,
  actual Express, real Postgres, and a private deterministic R service. It
  covers signup/login/logout, durable project reload, Collaborators add/role/
  remove confirmation and read-only views, cookie-only restoration/revocation,
  and audits page errors, unexpected console errors, request failures, and 5xx
  responses. It runs in CI.
- `npm run test:deployment:smoke` starts the actual production server process
  and checks pre-side-effect config refusal, trusted-TLS ingress, security
  headers, health/degraded readiness, CSRF, singleton web admission, revoke-all,
  secret-safe logs, graceful drain, and advisory-lock release.
- `npm run test:backup-restore:real` exercises real `pg_dump`/`pg_restore` into
  isolated source/target databases and roots, then verifies exact bytes, modern
  durable references, and every public-table fingerprint. Unit adversarial tests
  cover links, traversal, overlap, malformed manifests, changed bytes, nonempty
  targets, and command/credential boundaries.
- `npm run test:deployment:compose` renders Compose JSON and asserts the private
  namespace, loopback-only ingress, one-replica topology, non-root/read-only
  services, resource bounds, operations isolation, and shutdown ordering.
- The handler-focused R-worker suites (`*-worker.test.js`, part of
  `test:backend`) **mock the R
  caller** with instant, unboxed responses, so they prove handler/bridge wiring
  but **not** real R timing, serialization, or compute. Real end-to-end completion
  of the durable Seurat pipeline against a live R backend — including worker-lease
  renewal during the long R call — is covered by `npm run test:seurat-pipeline`.
  That check launches the standalone worker entrypoint, uses a deliberately
  short lease, observes at least two real heartbeat renewals during the R call,
  and proves a competing claimant cannot reap or steal the job after the
  original lease deadline. The default `JOB_WORKER_LEASE_SECONDS` remains 120
  for normal operation.
- `npm run test:deg-worker-pipeline` is the same real-R lease-renewal proof,
  scoped to `deg.find_markers.v1` specifically. The lease-renewal timer
  (`startClaimRenewal` in `backend/jobWorker.js`) is shared code across every
  R-facing handler, but the Seurat check above only exercises it through
  `seurat.pipeline.v1`. This check seeds a small synthetic clustered checkpoint
  directly at the DB layer (no R call for that step), reattaches it for real via
  `checkpoint.load.v1`, then runs `deg.find_markers.v1` for real with a short
  lease against an R-side diagnostic delay (`R_TEST_DEG_DELAY_MS`, gated the
  same way as `R_TEST_SEURAT_DELAY_MS`) on `POST /object/deg-find-markers`. It
  asserts at least two real heartbeat renewals, a rejected competing claimant,
  and correct `deg_markers`/`deg_summary` artifacts with no storage path/key
  leak. It needs only Seurat + dplyr (no HDF5 sample data), so it stays fast.
- The R/workflow checks (`test:seurat-pipeline`, `test:r-state-proxy`,
  `test:pbmc-parent`, `test:checkpoint-load`, `test:deg-markers`,
  `test:enrichment-gsea`) exercise the
  hardened live paths and require a real R/Seurat backend (`test:seurat-pipeline`
  also needs `hdf5r` for 10x HDF5); they skip cleanly when R/Seurat is absent.
  `test:r-storage` separately checks project-key validation, atomic RDS writes,
  and link-escape blocking at the R storage boundary. `test:r-public-bounds`
  checks plot dimensions, feature caps, and deterministic bounded QC sampling.
  CI installs `hdf5r` and runs `test:seurat-pipeline` so the UI-wired Seurat
  pipeline has a real R/standalone-worker/lease-renewal regression gate in pull
  requests. A separate required CI job also builds the exact production
  `r-backend/Dockerfile`, verifies every required R package (including the local
  ranked-enrichment and CellChat/NMF stacks), boots it under the
  unprivileged read-only container boundary, proves authenticated `/health`, and
  rejects an unauthenticated health request.
- `npm run test:cellchat-inference` is a **real R/Seurat/CellChat helper**
  smoke: it exercises deterministic bounded sampling, barcode-to-group
  alignment, source-object/RNG non-mutation, opaque durable group labels, and
  atomic private CSV plus signed completion-receipt output. It is not an
  Express/Postgres/worker or browser integration test.
  `npm run test:cellchat-receipt-interop` runs that real-R smoke and then proves
  the Node receipt verifier can authenticate and reconstruct its descriptor.
  `npm run test:cellchat-worker-pipeline` adds a real Postgres + standalone
  worker + spawned CellChat recovery path; it skips locally without a test
  `DATABASE_URL` and runs in CI.
  CI installs the exact CellChat 2.1.2 source pin and runs the same inference
  smoke in the production R image, but deployed browser + real Express/Postgres/
  worker + real R acceptance remains a release gate.
- CI runs on `pull_request` and `workflow_dispatch` only. The security-critical
  suites are additionally named explicitly in the workflow so their regression
  coverage is auditable.
