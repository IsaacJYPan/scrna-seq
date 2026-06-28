# Project / Job / R Execution — Implementation Design

> **Status: design only.** This document is an implementation *design* for how
> project-scoped collaboration, jobs, and R execution should fit together. It
> describes intended semantics and a proposed build order. **No worker queue,
> shared R execution, downloads, object storage, or production execution runtime
> is implemented by this document or the branch that adds it.** Where it
> describes future components (a worker, artifact storage, a reproducibility
> bundle), those are *proposals*, not claims of existing behavior. The current
> runtime behavior is described in [`architecture.md`](architecture.md),
> [`R_BACKEND.md`](R_BACKEND.md), and [`STATE_MANAGEMENT.md`](STATE_MANAGEMENT.md);
> where this document and those disagree about *what exists today*, those
> documents are authoritative.

## 0. Why this document exists

The codebase has, over several branches, built a durable foundation:

- **Datasets** are project-scoped (`datasets`, role-checked).
- **Analysis objects** and **jobs** carry a nullable `project_id` for
  project-readable metadata/history, while retaining `owner_user_id`.
- **Provenance** and **figure** metadata can be project-associated (append-only,
  role-checked, no figure file surface).
- **R active state** remains user/object-keyed and owner-verified
  (`deriveRStateKey`, `verifyRObjectOwnership`).
- **Jobs** are durable records with a server-managed status machine, but **no
  worker drains them** and R execution is still synchronous and in-process.

The next steps people will reach for — a worker queue, backgrounded R, "shared
project state" — are exactly the steps where it is easy to accidentally
introduce a shared mutable R session, leak one user's live objects to a
co-member, or build an irreproducible artifact model. This document fixes the
semantics **before** any of that is implemented, so the implementation branches
have a contract to build against and a clear list of things they must *not*
claim.

This is a design branch. It changes documentation, not runtime behavior.

---

## 1. Recommended execution model

**Recommendation (adopted default): collaborate through durable checkpoints and
artifacts, never through a shared mutable live R session.**

Concretely:

1. **Live R state is transient and private.** It stays owner/user-object-keyed,
   exactly as today. A live `global_obj` in the R process is an *execution
   detail* of one user computing on one analysis object — not a shared resource.
2. **No mutable live R session is shared across project members.** A project
   co-member never attaches to, reads, or mutates another member's in-memory R
   object. Visibility of *metadata* (an object exists, a job ran, a figure was
   produced) never implies access to the *live object*.
3. **Completed jobs / checkpoints / artifacts are the collaboration boundary.**
   What one member shares with another is a durable, immutable record — a
   completed analysis object, its provenance, its logs, its figures — not a
   handle to a running session.
4. **Every successful mutating analysis step creates a new immutable analysis
   object or checkpoint record** rather than mutating shared project state in
   place. Mutation in place is confined to one user's own transient R session
   between checkpoints; the *durable* result of a step is always a new row.
5. **Collaboration happens through durable analysis objects, jobs, provenance,
   figures, logs, and (future) artifacts** — append-only, role-checked, and
   reproducible — not by letting a co-member directly drive another user's live R
   object.

### Why this is the right default

- **It matches the security boundary that already exists.** `deriveRStateKey`
  derives the prefix `user-${user.id}` from the verified session and never from
  client input, and `verifyRObjectOwnership` requires the `X-Object-ID` to be a
  real `analysis_objects` row owned by the caller. Sharing live sessions would
  require *weakening* both. Keeping live state private means the collaboration
  features can be built without touching the R ownership boundary at all.
- **In-memory R state is intrinsically unsafe to share.** It is a single mutable
  `global_obj` in one process, lost on R restart, with no concurrency control.
  Two members mutating it concurrently is a data-corruption hazard, not a
  feature. The durable record is the only thing that is safe to expose.
- **Immutability is what makes the work reproducible.** A reproducibility bundle
  (Section 8) can only be assembled from durable, append-only records. If a step
  mutated a shared object in place, there would be nothing stable to hash, cite,
  or re-derive.
- **It is the smaller, safer change.** Checkpoint/artifact collaboration is
  additive on top of the existing durable tables; shared live state is a rewrite
  of the R execution and ownership model.

### The alternative, and its risks (rejected)

The alternative is a **project-global mutable R session**: one live Seurat object
per project that any member can mutate. This is rejected. Its risks:

- **Concurrency / lost updates.** Two analysts mutating one object race; one
  silently clobbers the other. There is no transactional R object.
- **Authorization blast radius.** A viewer or a removed member could observe or
  affect live computation; the ownership boundary that today is enforced in one
  place (`verifyRObjectOwnership`) would have to be re-derived for every R
  endpoint.
- **Irreproducibility.** "The current project object" has no stable identity to
  cite; provenance chains lose meaning.
- **Fragility.** A single R crash loses shared work for the whole project, not
  one user.

If a future product requirement genuinely needs "live co-editing," the correct
shape is still *not* a shared mutable session: it is fast branching off shared
immutable checkpoints (cheap copy-on-write objects) plus presence/locking at the
application layer — explicitly out of scope here and called out as an open human
decision (Section 12).

---

## 2. Canonical source-of-truth model

Seven kinds of state exist (or are proposed). Each answers a different question.
The single most important distinction: **only "live R active state" is transient
and private; everything else is durable, and durability — not the live session —
is what collaboration and reproducibility are built on.**

| State | What it represents | Durable? | Read by | Created by | Mutated by | Project members? | Viewers? | Reproducibility part? |
|---|---|---|---|---|---|---|---|---|
| **Database metadata** (rows in `analysis_objects`, `jobs`, `datasets`, `provenance`, `figure_collection`, project/org tables) | The authoritative record of *what exists*: objects, jobs, datasets, lineage, associations | **Durable** | Owner (owner-scoped rows); project members by role (project-scoped rows) | Server, on owner/admin/analyst action | Server only, within documented append/transition rules | Yes — by role (viewer reads metadata) | Read-only metadata | Yes (it *is* the index of reproducible records) |
| **Live R active state** (`global_obj`/`raw_obj` in the R process, keyed by `deriveRStateKey`) | The in-memory Seurat object one user is currently computing on | **Transient** (lost on R restart) | The owning user only (via owner-verified proxy) | The owning user's own R calls | The owning user's own R calls | **No** — metadata visibility never grants live access | **No** | **No** (it is an execution detail, not a record) |
| **Saved analysis object / checkpoint** (an `analysis_objects` row, ideally with a persisted workspace in a later branch) | An immutable snapshot of an analysis step and its lineage | **Durable** | Owner; project members by role when `project_id` set | Server, on owner/admin/analyst create *today* (via the create API); **produced on step completion in the future worker model** | **Immutable** after creation (new step → new row) | Yes — metadata by role | Read-only metadata | **Yes** (the spine of the lineage) |
| **Job record** (`jobs` row) | A unit of (long-running) work: its type, parameters, status, logs, error, lineage links | **Durable** | Owner; project members by role when `project_id` set | Server, on owner/admin/analyst create | Server, via the status machine only (see Section 3) | Yes — metadata/logs by role | Read-only metadata/logs | Yes (records *how* an object was produced) |
| **Job artifact** *(future)* | A produced file output of a job (e.g. an exported workspace, a results table, a reproducibility bundle) | **Durable** (proposed; immutable) | Owner; project members by role | Server/worker, on job completion | **Immutable** once written | Yes — metadata by role (bytes only via a future, explicit route) | Metadata yes; bytes per a future download decision | Yes |
| **Provenance record** (`provenance` row) | The recorded script/params/env that produced a result, plus its DAG (`parent_ids`) | **Durable**, append-only | Owner-scoped rows: owner. Project rows: members by role | R envelope → server; or project workflow (owner/admin/analyst) | **Append-only** (no project update/delete route) | Yes — by role | Read-only | **Yes** (core) |
| **Figure metadata / file** | Metadata about a generated figure; the rendered file itself | Metadata **durable**; file durable on disk | Metadata: owner or members by role. File: **no general access surface today** | Owner workflow, or project workflow (owner/admin/analyst) | Metadata append-only on the project path | Metadata yes — by role. **File: no** (project figure serializer omits `file_path`) | Metadata yes; **file no** | Metadata yes; file is a future artifact-download decision |
| **Generated R script / reproducibility export** *(future)* | A runnable R script reconstructing the analysis from durable records | **Durable** (proposed; immutable) | Owner; project members by role | Server/worker, **assembled from provenance/job/artifact records** (not frontend state) | **Immutable** once generated | Yes — by role | Per future download decision | **Yes** (it is the export) |

Notes that the table compresses:

- **`project_id` vs `owner_user_id` coexist.** A project-scoped row records both
  *which project owns the metadata* and *which user is responsible*. Project
  scope governs metadata visibility by role; creator ownership governs the live R
  boundary. They answer different questions and neither replaces the other.
- **"Project rows" vs "owner-scoped rows" are disjoint surfaces.** Project
  provenance/figures are written with `user_email = ''` so they never intersect
  the owner-scoped `user_email` CRUD; that is what keeps the project path
  append-only.
- **Cache** (`results_cache`) is deliberately omitted from the collaboration
  model: it remains strictly user-scoped and is not project-associated. It is a
  performance optimization, not a source of truth, and is intentionally not part
  of the reproducibility bundle (the provenance record, not the cache, is the
  durable account of how a result was produced).

---

## 3. Job lifecycle semantics

The status *constants* and the transition-validation machine already exist in
`backend/database.js` (`JOB_STATUSES`, `JOB_TRANSITIONS`, `validateJobTransition`,
`updateJobStatusForUser`). This section documents the **proposed/intended
meaning** of the lifecycle; it does not change the code, and most of the
lifecycle below is *not yet exercised* by any execution path (there is no worker).

### States

The backend already defines these status *constants* (`JOB_STATUSES`) — a
superset of the five the design prompt asks for. **Defining a constant is not the
same as reaching it:** today only `queued` (set when a job is created) and
`canceled` (set by an explicit cancel) are actually reached. The remaining
statuses are defined for a future executor and are **not produced by any current
code path**.

| Status | Meaning | Reached today? | Prompt-name mapping |
|---|---|---|---|
| `created` | Row exists but not yet enqueued (reserved; jobs are currently created already `queued`) | No (reserved) | — |
| `queued` | Durable, ready to run; **no worker drains it yet** | **Yes** (on create) | **queued** |
| `running` | A worker has claimed it and R execution is in progress | No — *future executor only; nothing sets this today* | **running** |
| `waiting_for_user` | Paused awaiting user input (reserved for interactive steps) | No — *future* | — |
| `completed` | Terminal: finished successfully | No — *future executor only; no code path sets this yet* | **succeeded** |
| `failed` | Terminal: finished with an error | No — *future executor only; no code path sets this yet* | **failed** |
| `canceled` | Terminal: canceled before (and, in future, during) execution | **Yes** (on cancel) | **canceled** |

> **Status naming is not final.** The lifecycle in this section is
> **proposed/intended**. The names above are the ones currently defined in the
> backend `JOB_STATUSES` constant (`backend/database.js`) — e.g. the success
> terminal is **`completed`**, not the prompt's "succeeded". Before any executor
> is implemented, the final status names must be **reconciled against and reuse
> the existing backend status constants** rather than introducing parallel names;
> renaming an existing value would require a migration. This is tracked as an open
> decision (Section 12).

### Transitions (validation allow-list — implemented; mostly not yet exercised)

```
created          → queued | canceled
queued           → running | canceled
running          → completed | failed | waiting_for_user | canceled
waiting_for_user → queued | running | canceled
completed        → (terminal)
failed           → (terminal)
canceled         → (terminal)
```

The validation table is implemented (`validateJobTransition` rejects anything not
listed), but **only the create edge (→ `queued`) and the cancel edge
(→ `canceled`) are exercised by any current code path.** Clients can only
*create* and *cancel*; every other edge must go through `updateJobStatusForUser`,
which is the path the **future** worker will use — it is reachable in code today
but nothing calls it to drive a job through `running`/`completed`/`failed`.

### Answers

- **Who creates jobs?** An authenticated user acting as owner/admin/analyst.
  Identity, `id`, `project_id`, and initial status are server-set; the client
  cannot supply `id`, an owner field, or a status. (`createJobForUser`,
  `createProjectJob`.)
- **When does a job become `running`?** Only when a worker *claims* it and begins
  R execution. **No worker exists today**, so nothing currently advances a job
  past `queued`. The transition is reserved for the future worker
  (`queued → running` via `updateJobStatusForUser`).
- **What does cancellation mean before running (`queued`/`created` →
  `canceled`)?** Pure intent recorded durably: the job will never start. No R
  process is involved. This works today.
- **What does cancellation mean during R execution (`running` → `canceled`)?**
  Today this is *unreachable* because nothing reaches `running`. In the future
  worker it must mean **both** of: (a) the durable status flips to `canceled`
  (intent recorded immediately and idempotently), and (b) the worker makes a
  best-effort attempt to stop the live R work for that job. See next point.
- **Can cancellation kill live R work, mark intent only, or both?** **Intended:
  both — intent first, best-effort kill second.** *Today only the intent half
  exists:* `cancelJobForUser` / `cancelProjectJob` flip the status to `canceled`
  synchronously and **explicitly touch no R process** (there is no execution to
  interrupt). The best-effort kill of in-flight R is part of the **future**
  worker. The intended rule for that worker: the durable `canceled` status is the
  source of truth and is set synchronously; stopping in-flight R is best-effort
  and asynchronous (R may be mid-computation in a way that cannot be interrupted
  instantly); cancel must never *block* on R cooperating, nor leave a job stuck
  non-terminal because R did not stop; a canceled job whose R work could not be
  interrupted in time is still `canceled`, and any late R output is discarded, not
  promoted to a result.
- **Partial logs / figures / provenance / failed result objects.** *(Intended
  rules for the future executor — today no job runs, fails, or produces partial
  output.)* Logs would be append-only (`logs_json`, capability exists today via
  `appendJobLogForUser`) and **retained** on failure and cancellation — the
  diagnostic record. Partial figures/provenance durably written before the
  terminal event would be retained as **records of a failed/canceled run** and
  clearly attributed to that job's non-success status (never silently presented as
  part of a clean result). A failed/canceled job would **not** yield a usable
  result analysis object.
- **Does every successful job produce a new analysis object?** **Intended rule
  (future executor): yes**, for a mutating analysis step — a `completed` mutating
  job would produce exactly one new immutable result analysis object
  (`result_analysis_object_id`, a column that exists today). Non-mutating jobs
  (e.g. a pure export or a read-only summary) may complete without a new analysis
  object but still produce a durable job record (and possibly artifacts). Today no
  worker completes jobs, so this is the rule the executor must follow, **not
  current behavior**. See Section 4.
- **Can a failed job produce provenance/logs/figures?** *(Intended; failures are
  not produced today.)* **Logs: always. Provenance/figures: only what was durably
  written before failure**, marked as belonging to a failed run. A failed job
  would not produce a *result* object.
- **Can a canceled job produce artifacts?** *(Intended; artifacts do not exist
  yet — see Section 8.)* It may have written **partial** artifacts/figures/logs
  before cancellation; those would be retained and attributed to the canceled job.
  A canceled job would produce **no** result analysis object and **no** artifact
  presented as a completed deliverable.
- **What should be immutable after terminal status?** The status itself is
  immutable **today** — `completed`/`failed`/`canceled` have no outgoing edges
  (enforced now by the empty terminal sets in `JOB_TRANSITIONS`). The *intended*
  additional immutability for the future executor: the `result_analysis_object_id`,
  the recorded `parameters_json`, the captured `error_json`, and any produced
  artifacts; logs effectively frozen at terminal (the worker stops appending).
  Terminal jobs are read-only records.

---

## 4. Checkpoint and branching semantics

- **Is every completed mutating step a new immutable analysis object?**
  **Intended: yes.** Today `analysis_objects` rows are already immutable after
  creation (there is no in-place update route) and are created directly through
  the create API. In the **future worker model**, each completed mutating step
  must *create* a new result row on completion rather than editing the input
  object — the rule is "new step → new row", never mutate in place.
- **Can users branch from any existing analysis object?** **Yes — this is
  implemented today.** Branching is reading a durable checkpoint as a parent
  (`parent_object_id`), which is exactly the collaboration boundary from
  Section 1: a new step takes an existing object as `parent_object_id` and the
  create API produces a new child object. (For a project object, the parent must
  be in the same project — lineage cannot cross a project boundary.)
- **Parent / lineage rule.** A child inherits `lineage_root_id` from its parent;
  a root object's `lineage_root_id` is its own id. Linked parents/provenance are
  ownership-checked (owner-scoped path) or same-project-checked (project path) at
  creation. Lineage is a DAG of immutable nodes.
- **Can two analysts branch from the same object concurrently?** **Yes.** Two
  children of the same immutable parent are independent rows; concurrent
  branching is safe precisely because the parent never mutates. This is the
  intended multi-analyst workflow.
- **Can two analysts write to the same result object?** **No.** Result objects
  are immutable and single-writer (created once, by one job, owned by one user).
  "Both work on it" is expressed as *both branch from it*, not *both mutate it*.
- **Should reruns overwrite or create new objects?** **Create new** (design
  rule). A rerun (same step, same or changed params) should produce a new analysis
  object and a new job; it must never overwrite a prior result. The deterministic
  `results_cache` may short-circuit *recomputation* for an identical key, but that
  is a cache hit serving an identical result — it does not mutate or replace the
  durable object.
- **How are parameters/defaults captured?** The job records the parameters it was
  created with (`parameters_json`). Provenance records the *effective* parameters
  and the script. **Server-resolved defaults must be captured explicitly** — the
  reproducibility record must distinguish "user supplied X" from "default X
  applied", so a future change to a default cannot silently change what a stored
  record means. (This is a requirement on the future worker/provenance writer,
  Section 8.)
- **How are warnings/logs captured?** The job carries an append-only log
  (`logs_json`) today; in the future executor, warnings and step logs would be
  appended there, and reproducibility-relevant warnings (e.g. "feature X not
  found", "downsampled") should *also* be recorded in the provenance/artifact
  record so they survive independently of the job log.
- **How are figures associated with a job/object/provenance record?** Through the
  same-project reference columns on the project figure row (`analysis_object_id`,
  `job_id`, `provenance_id`, `dataset_id`) — **these columns exist today**. A
  figure is thus traceable to the job that produced it, the object it describes,
  and the provenance of that result — without exposing the figure file itself.

---

## 5. Collaboration semantics

Role defaults (current): **owner/admin** manage and may cancel any project job;
**analyst** creates jobs and cancels only their own; **viewer** reads metadata
but cannot create, mutate, or cancel. **Project metadata visibility never implies
live R access.** These are the implemented defaults
(`cancelProjectJob`, `requireProjectRole`, `verifyRObjectOwnership`); items below
marked *(OPEN)* are human decisions, not current behavior.

- **Can project members read each other's analysis objects (checkpoints)?**
  **Yes — implemented today.** Metadata/lineage of project-scoped analysis objects
  is readable by any member by role (viewer included). They read the *record*, not
  the live R object.
- **Can project members read each other's logs?** **Yes — implemented today.**
  Project job logs are readable by members by role
  (`GET /api/projects/:id/jobs/:jobId/logs`).
- **Can project members read failed job logs?** Reads of a job's logs by role work
  today **regardless of status**; once the future executor produces `failed` jobs,
  their logs are readable the same way (failure logs are intended to be part of the
  durable diagnostic record).
- **Can project members read figures from failed jobs?** The figure **metadata**
  is readable by role today; once failed jobs exist, a figure attributed to one is
  readable the same way. The figure **file** is never served on the project path
  regardless of job status (no figure file surface).
- **Can viewers export completed checkpoints?** **Metadata: yes. A
  reproducibility export or any byte download: deferred** to a future
  artifact/download branch — see Section 8. *(OPEN: whether viewers, specifically,
  get byte/export downloads once that surface exists.)*
- **Can viewers download artifacts?** **No download surface exists today** for
  any role. When one is added, viewer downloadability is an explicit per-artifact
  decision *(OPEN)*; the conservative default is metadata-only for viewers.
- **Can analysts cancel only their own jobs or project jobs?** **Own jobs only.**
  An analyst canceling another member's job gets 403 (`cancelProjectJob`).
- **Can owner/admin cancel any project job?** **Yes** — owner/admin may cancel
  any cancelable job in the project (already-terminal → 409).
- **What happens to active jobs when a user is removed from a project?**
  *(OPEN — not implemented.)* Recommended: the removed user immediately loses
  project read/cancel rights; their in-flight project jobs should be **canceled
  by the system** (intent recorded; worker stops live R best-effort), because the
  job's responsible actor can no longer participate. The durable records remain
  (attributed to the now-removed user) for project history.
- **What happens to active jobs when a user's role changes?**
  *(OPEN — not implemented.)* Recommended: role changes apply to *future* actions
  immediately (e.g. demotion to viewer removes create/cancel rights going
  forward) but do not retroactively rewrite already-recorded jobs. An in-flight
  job continues unless explicitly canceled by someone now authorized.
- **What happens to live R sessions after role changes?** **Nothing changes about
  the R boundary**, because live R state is never project-shared. A role change
  cannot grant or revoke access to a live R object — there was never project
  access to it. The user's own live session remains their own (and remains
  transient).

---

## 6. R execution boundary

These are hard constraints. Any branch that violates one is wrong, regardless of
what feature it ships.

- **`verifyRObjectOwnership` remains owner/user-object verified** until a later
  implementation branch *intentionally* changes it with its own design and tests.
  Today it requires the `X-Object-ID` to be a real `analysis_objects` row owned
  by `req.user` (malformed → 400, unknown/not-owned → 404) before the request
  reaches R. No collaboration feature in the near-term plan relaxes this.
- **`deriveRStateKey` remains user/object-keyed** until a later branch
  intentionally changes it. The prefix is always `user-${user.id}` from the
  verified session; the optional `:obj-<id>` segment is appended only from the
  *verified* object id. The client never controls the prefix.
- **No project-global mutable R session may be introduced** — not as a feature,
  and not accidentally (e.g. by keying R state on `project_id`, by caching a
  "current project object", or by letting a project route forward another
  member's object id to `/api/r/*`). The state key must stay derived from the
  authenticated user.
- **No arbitrary user-provided R code execution.** R endpoints are a fixed,
  curated set of operations with structured parameters. The worker must not gain
  an "eval this R" path.
- **R must not receive arbitrary user-controlled paths.** Paths are
  server-derived and validated on both tiers (`validateRProxyPaths` /
  `R_PROXY_VALIDATED_PATH_FIELDS` on Node, `validate_path()` in R, kept in sync by
  `backend/r-path-drift.test.js`). The future worker inherits this: it passes
  server-derived storage keys/ids, never a client path.
- **The worker calls R through a controlled interface with server-derived
  paths/IDs.** The worker is a *trusted server-tier client* of R, exactly like
  the proxy today: it injects the `X-API-Token` and a server-derived state key /
  (future) `X-Job-ID`, and it derives every path/id itself. R continues to trust
  only headers injected by the server tier and to re-validate independently. R
  stays bound to loopback / a private network and performs no user auth.

---

## 7. Future worker architecture (high level — not implemented)

This section describes responsibilities and contracts; it implements nothing.

- **API server (Express).** Authentication, authorization (org/project roles),
  request validation, path validation, and creating durable `jobs` rows (status
  `queued`). It is the only tier that talks to the client. It does **not** run R
  itself in the target model; it enqueues work and serves durable records. It
  remains the place where `verifyRObjectOwnership` / `deriveRStateKey` /
  `validateRProxyPaths` live.
- **Worker.** Drains `queued` jobs, claims one (`queued → running`), invokes R
  through the controlled interface with server-derived paths/ids, streams/persists
  logs and progress, and on finish records the terminal status plus the result
  analysis object and/or artifacts. It is a trusted server-tier R client; it
  never accepts client input directly. It is the only component that advances a
  job past `queued`.
- **Database.** The source of truth for job status, lineage, parameters, logs,
  errors, and associations. The worker's claim, progress, and completion are all
  durable DB writes. Status transitions go only through the existing allow-list.
- **R backend.** Stateless-to-the-outside compute: it loads the inputs the worker
  names (by server-derived key/path), computes one operation, returns a result +
  provenance envelope, and persists/saves per-object state only as instructed. It
  trusts only server-injected headers and re-validates paths.
- **Artifact / checkpoint storage.** Durable storage for saved object workspaces
  and job artifacts (today: local `vault/`; target: object storage). The server
  chooses the storage key (as `datasets` already does); the key is never client
  supplied and never returned raw.
- **Logs.** Append-only on the job (`logs_json`) as the durable record; the future
  worker may *also* stream progress lines for live UI, but the durable log is the
  source of truth. Logs survive failure and cancellation.
- **Progress.** Recorded as durable updates on the job (e.g. a progress field
  and/or structured log entries), so a reconnecting client and a restarted worker
  both see consistent progress without a live connection.
- **Worker recovery after crash/restart.** A job claimed (`running`) by a worker
  that died must be detectable (e.g. a claim/lease with a heartbeat or a visible
  timeout) and either resumed or moved to `failed` with an honest log — never left
  silently stuck in `running`. The DB, not worker memory, holds the truth.
- **Idempotency.** Claiming and completing must be idempotent: completing the same
  job twice, or two workers racing to claim, must not produce two result objects
  or double-apply a transition. The deterministic cache key
  (`makeCacheKey(operation, params, dataVersion, parentIds, userEmail)`) gives
  recomputation idempotency; job-level idempotency comes from single-claim
  semantics on the durable row.
- **Retries.** Limited and explicit. Transient infrastructure failures may retry
  a bounded number of times; **analysis failures (bad params, R error) must not
  auto-retry** — they are real results the user must see. Every attempt is logged.
  Retries must never silently produce duplicate result objects (idempotency
  above).

---

## 8. Future artifact / reproducibility model (not implemented)

- **Minimum reproducibility bundle.** Enough to re-derive a result from durable
  records alone, with no frontend state required:
  - dataset hash (`datasets.sha256`) and dataset identity
  - project id and analysis object id (and lineage: parent + root)
  - job id and the job's recorded parameters **and resolved defaults**
  - effective parameters + the executed R script text (from provenance)
  - warnings and the relevant log entries
  - environment: R version, package versions, **Seurat version**
  - app commit (the server build that produced it)
  - the generated R script assembled from the above
- **Mandatory fields.** dataset hash, project id, analysis object id, job id,
  parameters (with defaults distinguished), R/Seurat/package versions, app commit,
  and the generated script. A bundle missing any of these is not a valid
  reproducibility artifact and must not be presented as one.
- **How the fields connect.** dataset hash → which input; project/object/job ids →
  *where in the lineage*; parameters/defaults + script + warnings/logs → *exactly
  what ran*; R/package/Seurat versions + app commit → *the environment*; the
  generated script ties them into something runnable. The provenance DAG
  (`parent_ids`) links a step to its inputs so a bundle can include the whole
  chain.
- **Where script fragments come from.** From the **R-generated provenance script
  text** (`make_provenance` already records the executed script), assembled
  server-side from the durable provenance/job/artifact records — **not** from
  frontend state. The frontend is a UI over durable records; it is never the
  source of truth for a reproducibility export.
- **Should generated R scripts be assembled from records, not frontend state?**
  **Yes — unconditionally.** Assembling from records is what makes the export
  trustworthy and reproducible after the fact; assembling from frontend state
  would make it depend on a transient UI session.
- **Should artifacts be immutable?** **Yes.** Once written, an artifact (bundle,
  generated script, exported workspace) is immutable and content-addressable where
  practical. A new export is a new artifact.
- **Which artifacts are visible to viewers?** Artifact **metadata** by role
  (viewer included), consistent with the rest of the project metadata model.
- **Which artifacts are downloadable, if any, in a later branch?** **None today.**
  A download/byte-serving surface is deferred to a dedicated branch (it adds real
  path/authorization surface). When added, downloadability is an explicit
  per-artifact, per-role decision; the conservative default is metadata-only for
  viewers and byte access for owner/admin/analyst, revisited as an *(OPEN)*
  decision.

---

## 9. Non-goals (this branch)

This branch produces documentation only. It explicitly does **not**:

- implement a worker or job queue (nothing drains `jobs`);
- change R execution / the R proxy / the synchronous execution model;
- introduce shared or mutable project R sessions, or any project-global R state;
- change `deriveRStateKey`, `verifyRObjectOwnership`, or R proxy ownership;
- add object storage;
- add download routes (dataset, figure, or artifact);
- add public links;
- add comments, invitations, or audit logs;
- add arbitrary R code execution or any user-controlled R path;
- do broad frontend / UI workflow work;
- change production deployment;
- implement secure-cookie sessions;
- add database migrations (no schema change ships here; proposed future schema, if
  any, lives in this doc only).

---

## 10. Recommended next implementation branches

A proposed sequence. Each entry states what it must **not** claim on completion —
to keep the project honest about what is actually done.

### A. `job-worker-contract-and-schema`
- **Purpose.** Define the worker↔DB↔R contract concretely: how a job is claimed,
  how progress/logs are persisted, the (future) `X-Job-ID` header shape, the
  claim/lease/heartbeat fields, and any small schema needed to support claiming
  and progress — **without** running anything.
- **Why first.** Everything downstream depends on the claim/idempotency/recovery
  contract; getting it wrong later means reworking the worker and the schema.
- **Main risks.** Designing a claim model that isn't crash-safe or idempotent;
  accidentally introducing a project-keyed state path.
- **Required tests.** Schema migration idempotency; transition allow-list
  unchanged; claim/idempotency helpers at the DB layer; assertion that the R
  ownership boundary is untouched.
- **Must not claim after completion.** That jobs execute, that R is backgrounded,
  or that a worker exists. Only the *contract + schema* exist.

### B. `worker-queue-drain-minimal`
- **Purpose.** A minimal worker that claims one `queued` job, runs **one** existing
  R operation through the controlled interface, streams/persists logs, and records
  `running → completed|failed`, producing the result analysis object on success.
- **Why second.** It is the first real execution and must build on A's contract;
  keeping it to one operation contains risk.
- **Main risks.** Stuck `running` jobs after a crash; double-claim; leaking a
  client path into R; blocking cancel on R.
- **Required tests.** Single-claim/idempotency under concurrency; crash-recovery
  of a claimed job (no stuck `running`); cancel-during-run records `canceled` and
  discards late output; R path validation still enforced; ownership boundary
  unchanged.
- **Must not claim after completion.** That all operations are backgrounded, that
  shared R exists, or that this is production-grade. Only a minimal drain exists.

### C. `job-artifacts-and-checkpoints`
- **Purpose.** Persist saved object workspaces / job artifacts as immutable
  durable records (metadata + server-chosen storage key), associated to job/object/
  provenance. Still **no** download surface.
- **Why third.** Needs real job execution (B) to produce artifacts; reproducibility
  export (D) needs durable artifacts to assemble from.
- **Main risks.** Storage layout that has to be retrofitted before downloads;
  mutable artifacts; client-supplied storage keys/paths.
- **Required tests.** Artifact immutability; server-owned storage key (never
  returned raw, never client-supplied); role-checked metadata reads; same-project
  reference integrity.
- **Must not claim after completion.** That artifacts are downloadable, that
  reproducibility bundles are complete, or that object storage is implemented.

### D. `reproducibility-bundle-export`
- **Purpose.** Assemble the Section 8 bundle (generated R script + manifest of
  mandatory fields) **from durable records**, stored as an immutable artifact.
- **Why fourth.** Requires durable jobs (B) and artifacts/checkpoints (C); it is
  the payoff of the immutability discipline.
- **Main risks.** Assembling from frontend state instead of records; missing a
  mandatory field; presenting an incomplete bundle as complete.
- **Required tests.** Bundle rejects/marks-incomplete when a mandatory field is
  missing; script assembled only from provenance/job/artifact records; defaults
  distinguished from user-supplied params; immutability.
- **Must not claim after completion.** That bundles are downloadable by end users
  (unless a download branch shipped) or that reproducibility is "complete" beyond
  the documented bundle.

### E. `secure-cookie-sessions`
- **Purpose.** Migrate browser auth from `localStorage` Bearer tokens to httpOnly,
  secure, SameSite cookies.
- **Why here.** Independent of the worker, but a prerequisite for any real
  production exposure of downloads/artifacts; sequenced before broad external
  surface.
- **Main risks.** CSRF surface from cookie auth; breaking the existing
  `electronAPI` fetch client; session-fixation.
- **Required tests.** CSRF protection on state-changing routes; auth still scoped
  per user; existing HTTP-auth tests adapted and green.
- **Must not claim after completion.** That the app is production-ready or that
  deployment hardening is done.

### F. `object-storage-foundation`
- **Purpose.** Replace the local `vault/` layout with an object-storage abstraction
  for uploads and artifacts, keyed by server-chosen keys.
- **Why last in this list.** Largest infra change; benefits from the artifact
  model (C) and bundle (D) being settled so the storage interface fits real needs.
- **Main risks.** Retrofitting storage layout after downloads exist; key
  disclosure; cross-filesystem/move edge cases.
- **Required tests.** Server-owned keys never disclosed; per-project/per-user
  isolation preserved; migration of existing vault data; no path escapes.
- **Must not claim after completion.** That downloads/public links exist (unless a
  separate branch added them) or that the deployment is production-grade.

---

## 11. Acceptance criteria

This branch is acceptable only if **all** hold:

- [x] Docs clearly distinguish live R state, durable checkpoints, jobs, artifacts,
      provenance, and figures (Section 2 table).
- [x] Docs explicitly preserve the current R ownership boundary
      (`verifyRObjectOwnership` / `deriveRStateKey` unchanged; Section 6).
- [x] Docs answer whether project members can access each other's live R objects
      (no — Sections 1, 5, 6).
- [x] Docs answer whether successful jobs create immutable result objects/
      checkpoints (yes for mutating steps — Sections 3, 4).
- [x] Docs describe cancellation semantics, before and during execution (Section 3).
- [x] Docs describe concurrency/branching semantics (Section 4).
- [x] Docs describe logs/warnings/partial-failure behavior (Sections 3, 4).
- [x] Docs describe future worker responsibilities without implementing them
      (Section 7).
- [x] Docs include non-goals (Section 9).
- [x] Docs include a follow-up branch plan (Section 10).
- [x] Docs do not overstate production readiness (status banner; "must not claim"
      lists; *(OPEN)* markers).

---

## 12. Open human decisions

These are genuine product/policy choices the design intentionally leaves open;
they are *not* current behavior and must be decided (with their own tests) in the
relevant implementation branch:

1. **On project removal of a user:** auto-cancel their in-flight project jobs, or
   leave them running under owner/admin oversight? (Section 5 recommends
   auto-cancel.)
2. **On role demotion (e.g. analyst → viewer):** apply to future actions only
   (recommended), or also cancel their in-flight jobs?
3. **Viewer download rights** once an artifact/download surface exists:
   metadata-only (conservative default) vs. byte access for completed checkpoints.
4. **Per-artifact downloadability** and whether any artifact ever becomes a public
   link (current non-goal).
5. **Whether "live co-editing" is ever a product requirement.** If so, the design
   mandates fast branching off immutable checkpoints (+ app-layer
   presence/locking), **not** a shared mutable R session.
6. **`completed` vs `succeeded` naming** — keep `completed` (current) or add an
   alias; either way, no rename without a migration.
