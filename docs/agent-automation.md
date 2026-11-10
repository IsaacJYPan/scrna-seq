# Delegated agents: implementation status

This page describes what is implemented from the [agent governance design](spec.md).
The design is the target; this page is the current contract. Anything the design
describes that is not listed here as implemented is not available.

| Spec phase | Status |
| --- | --- |
| 0. Authority inventory and contracts | Implemented for the routes below |
| 1. Read-only agents and inert proposals | Implemented |
| 2. Approved local workflow execution | Implemented: Seurat QC/clustering (10x HDF5, Visium), cluster markers, and the [trusted method library](../trusted-methods/README.md) |
| 3. Qualified HPC target | Slurm target implemented (SSH login node), with a qualification run for sandbox use |
| 4. Isolated development | Implemented: agent R scripts in sandboxes, locally or on a qualified Slurm target |
| 5. Bounded protocol automation / MCP | MCP server, two-step composition, and reviewed agent reports implemented; standing acceptance not started |

## What exists

- **Agent principals.** Each agent is a distinct principal (`agt_…`) sponsored by
  one person. Its display name and optional client label are descriptive only.
- **Delegations.** A project-scoped grant (`dlg_…`) of a subset of capabilities,
  a disclosure profile, limits, and an expiry (15 minutes to 30 days). The
  sponsor must currently hold every role a capability requires.
- **Credentials.** Opaque bearer tokens `tro_agent_<43 chars>`, shown once and stored
  only as SHA-256 digests. At most three active credentials per delegation; each
  expires no later than its delegation.
- **Effective authority**, checked on every request:
  `sponsor's current project role ∩ delegation capabilities ∩ delegation project`.
  Removing or downgrading the sponsor narrows or removes the agent's authority
  immediately; revocation, expiry, and a disabled principal stop the credential.
- **Inert proposals.** Agents can submit code, method, or workflow proposals as
  text (≤ 256 KiB, default 64 KiB). Nothing parses, installs, or runs them.
  Content is immutable in the database. A person can record one review decision:
  `declined` or `noted`. Noting is not approval.
- **Audit.** `automation_audit_events` is append-only and names the actual actor
  kind. Agent rows carry the principal, sponsor, delegation (and version), and
  credential. Denied agent operations are recorded as well.
- **Kill switches.** Revoke one credential, one delegation, all of your own
  delegations in a project, or (owners/admins) every delegation in a project.
- **UI.** *Project → Agent access* shows each agent, its sponsor, capabilities,
  visibility, limits, credentials, proposals, and activity.

### Capabilities

| Capability | Status | Sponsor role required |
| --- | --- | --- |
| `metadata.read` | Delegable | any project role |
| `results.read` | Delegable | any project role |
| `proposal.create` | Delegable | owner, admin, analyst |
| `workflow.plan`, `workflow.executeApproved`, `run.cancelOwn` | Delegable | owner, admin, analyst |
| `development.executeCandidate` | Delegable | owner, admin, analyst |
| `report.write` | Delegable | owner, admin, analyst |
| `artifact.export` | Planned (phase 5) | — |
| `workflow.approve`, `study.expand`, `result.accept`, `result.publish`, `delegation.manage` | Human-only | — |
| `security.manage`, `target.manage`, `budget.increase` | Never delegated | — |

The capability catalog lives in `backend/policy/agentCapabilities.js`.
Switches in the stored policy (`allowArbitraryCode`,
`allowCandidateCodeExecution`, `allowArtifactExport`, `allowGpu`,
`allowJobArrays`) are fixed to `false`; requests to change them are rejected.
Agent code runs only through `development.executeCandidate`, inside a sandbox a
person defined (see *Isolated development* below); no other route runs it.
Delegation limits: `maxOpenProposals`, `maxProposalBytes`,
`maxRequestsPerMinute`, `maxOutstandingRuns` (default 1), and
`maxReservedCpuSeconds` (default 14,400).

### Disclosure profiles

| Profile | Agent sees |
| --- | --- |
| `identifiers` (default) | Ids, file types, sizes, digests, statuses, timestamps |
| `labels` | Also project name/description and original filenames |

No profile exposes storage locations, dataset metadata, job parameters, logs, or
errors. Data an agent is allowed to read can still reach its model provider;
choose the profile with that in mind.

## Approved workflow execution (phase 2)

**Releases.** The only operations an agent can run are listed in
`backend/workflowTrust/catalog.js`. A release digest covers its handler files
(`backend/seuratPipeline.js`, `backend/jobs/pipelineHandlers.js`,
`r-backend/plumber.R`), parameter schema, resources, inputs, and outputs. When
any of those bytes change, the release gets a new id, the old one is marked
superseded, and it must be approved again. The first release,
`seurat-qc-cluster` v1, runs the existing `seurat.pipeline.v1` job on an
uploaded 10x HDF5 dataset.

The second release, `seurat-markers` v1, runs the existing
`deg.find_markers.v1` job (cluster marker genes). It does not take datasets:
it runs on a clustering a person accepted (see *Follow-on studies* below). Its
result is the marker summary artifact; the marker table itself stays internal.

The `spatial-seurat` release runs the existing `spatial.seurat.v1` job on a
validated classic Visium Space Ranger bundle with the same parameter contract.
`seurat-multisample` runs `seurat.multisample.v1` on several 10x HDF5 captures:
the study pins every dataset and fixes a sample sheet (`fixedParameters.samples`,
with sample, condition, optional donor and batch) that must list exactly those
datasets; plans name the sheet's first dataset, and admission refuses the run if
any sample's bytes changed. `pathway-gsea` (`enrichment.gsea.v1`) and
`cellchat-single-context` (`cellchat.infer.v1`) run on any accepted Seurat
analysis; their group, species, database and threshold choices are design
parameters a person fixes.

### Trusted method library

Each method in [`trusted-methods/catalog.json`](../trusted-methods/README.md) is
also a release, with job type `trusted.method.v1`. Its digest covers the
method's R file, its catalog entry (parameters, outputs, metrics, resources,
upstream provenance and declared deviations), and the shared executor files.
Approval shows the upstream tutorial, citation and deviations.

- **Inputs.** A method runs on the accepted result of a study whose release it
  lists in `accepts` (for example `doublets-scdblfinder` → `subset-cells` →
  `recluster-integrate` → `label-clusters`). Every link is a person's
  acceptance. `seurat-markers` also accepts any method that produces an
  analysis.
- **Design parameters.** Parameters with role `design` (metadata columns, gene
  lists, label maps, which cells to keep) must be fixed when the study is
  created; varying one is `PROTECTED_PARAMETER`. Text parameters must match a
  fixed grammar and are always design parameters. Agents may vary `tuning`
  and `display` parameters.
- **Execution.** The job stores only `{ method, methodVersion,
  methodSourceSha256, values }`. The worker loads the method from its own
  library, refuses `TRUSTED_METHOD_CHANGED` if the bytes differ, revalidates
  values, compiles the script with the workflow-package wrapper, and runs it in
  the isolated no-network sandbox. Outputs are checked with the workflow output
  validator.
- **Results.** One transaction records a new analysis object, a lineage edge,
  every output (the `analysis` RDS becomes the new object's checkpoint, so it can
  be opened in the workspace or feed a follow-on), and a
  `trusted_method_summary` artifact. Only the metric keys the catalog declares
  reach the trial summary and selection rules.
- **Requirements.** The isolated R runtime must be configured. The
  `expert_r.execute` grant is not required, since no caller code runs. Packages
  outside the base image are installed with
  `--build-arg INSTALL_TRUSTED_METHOD_PACKAGES=true` on the R image.

**Approval.** Project owners and admins approve one exact release digest per
project under *Agent access → Approved workflows*. Agents cannot approve.

**Studies.** A person with write access defines a study: the approved release,
the exact input datasets (pinned by SHA-256, with a study-owned input object),
the parameters the agent may vary and their allowed values, a trial limit, a
limit on active runs, and a CPU-second budget. Every other parameter is fixed.
Studies cannot be edited, only closed. An agent sees only open studies that its
sponsor created.

**Plans.** The agent asks for a plan with a study, dataset, and choices. The
server checks that each choice is a permitted value, applies the release's
cross-parameter checks, and stores an immutable plan whose SHA-256 digest
covers the actor, release, approval, inputs, full parameters, resources, and
outputs. Plans expire after an hour. A choice outside the study is
`STUDY_AMENDMENT_REQUIRED`; a forbidden combination is
`STUDY_CONSTRAINT_VIOLATION`.

**Admission.** Submitting `{ planId, planDigest, requestId }` runs one
transaction that rechecks the delegation, the sponsor's write role, the approval,
the current release, the open study, and the pinned input. It then checks every
budget, reserves the run's maximum CPU time, records the run, and queues the job.

| Budget | Source | Default |
| --- | --- | --- |
| Active agent runs, whole installation | `AGENT_MAX_OUTSTANDING_RUNS` | 4 |
| Active runs, all of one sponsor's agents | `AGENT_MAX_OUTSTANDING_RUNS_PER_SPONSOR` | 2 |
| Active runs and total reserved CPU seconds, one agent | delegation limits | 1 / 14,400 |
| Trials, active runs, and CPU seconds, one study | study | set by its creator |

Failing a budget returns `429 BUDGET_EXCEEDED` with `details.budget` naming the
level. Admissions are serialized with one database lock, so concurrent agents
cannot overrun a shared budget. Reservations are never refunded: failed and
canceled runs still count against trials and CPU budgets. The same `requestId`
returns the original run; a plan can be submitted only once.

**Dispatch recheck.** When the worker claims a queued agent job it checks again.
It cancels the job with `AGENT_AUTHORITY_REVOKED` before any R contact if the
delegation was revoked or expired, the approval was revoked, the release was
superseded, the study was closed, or the agent asked to cancel.

**Runs and results.** Run states are `queued`, `running`, `cancel_requested`,
`candidate_ready`, `quarantined`, `failed`, and `canceled`. `candidate_ready`
means the job completed and produced its declared result object; it is not
scientific acceptance. Output that completes after a cancellation request or
after the delegation was revoked is `quarantined`. Agents read a bounded result
summary (numbers, booleans, and short strings only).

**Acceptance.** A person accepts one candidate per study with
`expectedAcceptedRunId` set to the study's current accepted run (or `null`). If
it changed in the meantime the request fails with `BASELINE_CHANGED`. Each
acceptance is recorded append-only. Accepting moves the study's accepted-result
pointer; it never copies or overwrites another analysis. *Agent access →
Approved workflows* shows each study's trials in one table (the varied
choices, the result's cells and clusters, and any summary field that differs
between trials) so the candidates can be compared before one is accepted.

**Selection rules.** A study may declare `selectionRule: { metric, goal }`
(goal `max` or `min`), for example `{ "metric": "nClusters", "goal": "max" }`.
The metric must be one the release declares in `selectableMetrics`, and its
kind must be `descriptive` or `quality`. Inferential metrics, such as counts of
significant genes or test statistics, are refused: ranking trials by them would
reward trying analyses until one reaches significance. The rule is fixed with
the study.
`GET …/studies/:studyId` then reports `selection`: the finished trial the rule
ranks first (earliest on ties), and the comparison table marks it *Best by
rule*. It is a recommendation: nothing is accepted automatically. Agents
without `results.read` see the rule but not trial summaries or the pick.
*Open in workspace* on a candidate's row opens its result object for normal
inspection.

**Follow-on studies.** A study of a release whose input is an analysis object
(today `seurat-markers`) is created with `sourceStudyId` instead of
`datasetIds`. The source study must run the release the follow-on declares as
its input (`seurat-qc-cluster`), must have an accepted result, and must have
been created by the same person (runs execute as the study creator, who must
own the result). The study pins that exact result object, the run it came from,
and the acceptance version; accepting a different result in the source study
later does not change it. Agents plan follow-on trials as usual, passing the
`datasetId` listed in the study's `inputs`. A follow-on run is
`candidate_ready` once its job completed and recorded the declared summary
artifact, and acceptance records that artifact. In the UI, choose the marker
release under *New study* and pick the source study under *Builds on the
accepted result of*. Follow-on studies run locally only.

**What is and is not enforced.** Budgets are enforced at admission. The local
worker runs one job at a time, and physical CPU and memory limits come from the
R runtime container's configuration, not from a per-run sandbox. Runs execute
in the shared R service, so the isolation is the existing trusted-lab
deployment model (see [deployment](deployment.md)), not a hostile-tenant
boundary. HPC targets are phase 3.

## Slurm execution target (phase 3)

Seurat pipeline runs (`seurat.pipeline.v1`, `seurat.multisample.v1`) can run on
a Slurm cluster instead of the installation's R service. People choose **Run on →
Slurm cluster** in the workbench; a study created with
`executionTarget: "slurm"` sends every agent run in it to the cluster.

**How a run executes.** The worker claims the job as usual, then over SSH to the
login node it:

1. creates `<SLURM_REMOTE_ROOT>/<jobId>/` with `input/`, `output/`, `lib/`;
2. copies `r-backend/hpc-runner.R`, `r-backend/lib/seuratPipelineCore.R` (the same
   analysis code the R service runs), `params.json`, `inputs.json`, and the dataset
   files;
3. writes `job.sh` with `--job-name=tro-<jobId>`, CPUs, memory, and wall time
   (an agent run's reservation, or 1 CPU / 8 GiB / 1 h), plus partition, account
   and QoS, and submits it with `sbatch --parsable`;
4. polls `sacct` (falling back to `squeue`) and renews its lease meanwhile;
5. on `COMPLETED`, copies back `result.json` and `checkpoint.rds`, verifies the
   checkpoint's SHA-256, and records the result exactly as for a local run.

The dispatch is recorded in `hpc_dispatches` before `sbatch`. A restarted worker
re-attaches to the stored Slurm job id, or finds it by its `tro-<jobId>` name,
instead of submitting again. Canceling the job in the app, or an agent canceling
its own run, sends `scancel`. Failed jobs record the Slurm state and the tail of
`slurm.out` in the job log.

**Configuration** (web and worker processes):

| Variable | Meaning |
| --- | --- |
| `SLURM_SSH_TARGET` | `user@login-node` for a dedicated service account |
| `SLURM_SSH_KEY`, `SLURM_SSH_KNOWN_HOSTS`, `SLURM_SSH_PORT` | Key file, pinned host keys (enables strict checking), port |
| `SLURM_REMOTE_ROOT` | Absolute cluster directory for run workspaces (for example scratch) |
| `SLURM_PARTITION`, `SLURM_ACCOUNT`, `SLURM_QOS` | Passed to `sbatch` |
| `SLURM_RSCRIPT` | Command that runs R on compute nodes, for example `apptainer exec /path/traceomics-r.sif Rscript` |
| `SLURM_MODULES` | Optional `module load` list |
| `SLURM_POLL_SECONDS` | Poll interval (default 30) |
| `SLURM_MAX_RUNNING` | Cluster jobs waited on at once (default 4; `0` puts Slurm jobs in the local queue) |

The compute nodes need R with Seurat, hdf5r, jsonlite and digest; the simplest
route is the project's R image converted to Apptainer. `GET
/api/projects/:projectId/compute-targets` (people) and `GET
/api/automation/v1/projects/:projectId/targets` (agents, `traceomics targets
list`) report whether the cluster is reachable, using `sinfo`.

**Execution lanes.** Slurm jobs have their own worker loops
(`SLURM_MAX_RUNNING` of them) and their own claim limit, so a job waiting in the
cluster queue never holds the local slot, and local work never delays a Slurm
submission.

**Current limits.** Of the approved workflows, only the Seurat pipelines run on
Slurm; agent sandbox runs can also use it once the target is qualified (see
*Sandboxes on Slurm*). Approved workflow runs on the cluster rely on the site's
Slurm and container configuration for isolation. Remote commands are built from
validated tokens and single-quoted; no caller text reaches the remote shell.

## Isolated development (phase 4)

An agent with `development.executeCandidate` can write and run its own R
scripts, but only inside a **sandbox** a person defined. This is how an agent
does analysis that no approved workflow covers, without being able to change
existing work.

**Sandboxes.** A person with write access picks 1-10 of their own saved
analyses (each pinned by its checkpoint's SHA-256), a run limit, at most 5
active runs, and a CPU-second budget. Content is immutable; a sandbox can only
be closed. An agent sees only open sandboxes its sponsor created.

**Runs.** `POST …/sandboxes/:sandboxId/runs` with `{ requestId, title, script,
inputAnalysisObjectId? }` runs the script once as an ordinary Expert R job owned
by the sponsor. In the local target that is the ephemeral Expert R container:
no network, a read-only copy of the pinned checkpoint available as `obj`, no
project storage mount, 2 CPUs, 8 GiB, 15 minutes, and at most 50 output files
(200 MB). Outputs are written with `write_table`, `save_figure`, and
`save_workspace`. The exact R environment is pinned at submission. The admission
transaction rechecks the delegation, the sponsor's write role and Expert R
access, the open sandbox, and the pinned input, then checks the installation,
sponsor, agent, and sandbox budgets (shared with approved workflow runs) and
records the run. The worker's claim-time recheck cancels a queued run if the
delegation was revoked or expired, the sandbox was closed, or the agent asked to
cancel. The same `requestId` returns the original run.

**What the agent sees.** `GET …/sandbox-runs/:runId` returns the run state
(`queued`, `running`, `cancel_requested`, `draft_ready`, `quarantined`,
`failed`, `canceled`), the output file list, the last lines of the R console
(on success and failure), and the script as readable steps. With
`results.read`, `GET …/sandbox-runs/:runId/files/<name>` returns a text output
(up to 256 KiB) or a PNG/SVG figure (up to 2 MiB, base64). Files are read from
the stored bundle after its checksum is verified.

**Drafts and promotion.** Every output is a new draft result: a child of the
input, private to the sponsor, like any Expert R result. Nothing existing is
changed. Under *Agent access → Sandboxes* the sponsor (or a project owner or
admin) reads each run's steps, figures, tables, and console, and promotes or
discards it, once. Promoting publishes the result as a project branch named
after the run, which makes it visible to the rest of the project.

**Notebook view.** Each run is shown the way the app shows notebooks:
numbered, read-only Markdown and R cells. Each step of the script (split at
`# ---- Normalize ----` or `# Normalize ----` comments) becomes a Markdown cell
with the step's title and leading comments, followed by its R code, and each
output file appears under the step whose code names it. The default *Readable*
view hides defensive code: `stopifnot`, `stop`, `warning`, and `message` calls,
guard clauses whose only effect is to stop or return, and `tryCatch`, `try`, and
`suppressWarnings`-style wrappers, which are reduced to the expression they
protect. *Exact code* shows what ran. *Save as notebook* copies the run into a
notebook in one of the project's analyses (with the run id and script SHA-256 in
its first cell), where it can be read, edited, and versioned like any other
notebook. The same view is available for an approved release's analysis source
(*Read the analysis steps*), which for `seurat-qc-cluster` is
`r-backend/lib/seuratPipelineCore.R`. That file is now part of the release
digest, so approvals of the earlier `seurat-qc-cluster` release must be given
again.

### Sandboxes on Slurm

A sandbox can send its runs to the Slurm target, with a per-run reservation
(1-64 CPUs, 1-1024 GiB, 1-48 hours) set when it is created. This is allowed only
while the target is **qualified** for sandbox use.

The R process runs inside the operator's container command, with the same
runner and helpers as the local container:

| Variable | Meaning |
| --- | --- |
| `SLURM_SANDBOX_EXEC` | Container command, for example `apptainer exec --containall --cleanenv --no-home --network none --bind {work}:/work /path/traceomics-r.sif`. `{work}` is the run's work directory. |
| `SLURM_SANDBOX_IMAGE_DIGEST` | `sha256:…` of that image, recorded with every result |
| `SLURM_QUALIFICATION_MAX_AGE_DAYS` | How long a qualification stays valid (default 30) |

The worker stages `work/expert-runner.R`, `work/input/checkpoint.rds`, and
`work/input/analysis.R`, makes the input read-only, and submits a job script
that runs the container and then archives `work/output`. It lists the archive on
the login node (no links or special files, at most 50 files and 200 MB),
copies it back, extracts it into a private directory, validates every file again
exactly as the local broker does, and stores a fresh bundle. Results record the
policy `slurm-sandbox-policy.v1` and the configured image digest. Cancellation
and re-attachment after a worker restart work as for Seurat runs.

**Qualification.** `npm run slurm:qualify` (same `SLURM_*` settings and
`DATABASE_URL` as the worker) runs three small jobs on the real cluster inside
the sandbox container and records the result in `hpc_qualifications`:

| Check | Passes when |
| --- | --- |
| `reachable` | `sinfo` answers |
| `sandbox-configured` | `SLURM_SANDBOX_EXEC` and `SLURM_SANDBOX_IMAGE_DIGEST` are set |
| `job-roundtrip` | the probe job completes and its output comes back |
| `no-network` | the sandboxed R process cannot open an outbound connection |
| `no-job-submission` | `sbatch` and `srun` are missing or fail inside the sandbox |
| `no-credentials` | no `~/.ssh`, SSH agent socket, or cloud credentials are visible |
| `input-read-only` | writing into the staged input directory fails |
| `cpu-limit` | the process is pinned to no more CPUs than requested |
| `memory-limit` | a job allocating ~3 GiB under `--mem=512M` does not complete |
| `cancel` | `scancel` stops a running job |

Agent sandboxes can use the cluster only while the latest record for the current
settings passed and is recent; changing the container command, image,
partition, account, QoS, modules, or run directory requires a new run. The
compute targets list (`GET …/compute-targets`, `traceomics targets list`) shows
`sandbox.ready` and the last checks. The checks are evidence about this
configuration, not a proof of isolation: kernel and scheduler vulnerabilities,
shared filesystems outside the run directory, and site policy still matter.

## Agent reports (phase 5)

An agent with `report.write` can draft a report (for example a paper) section by
section for people to review.

| Operation | Route | Capability |
| --- | --- | --- |
| Start a report | `POST …/reports` with `{ requestId, title }` | `report.write` |
| This agent's reports, with each section's status | `GET …/reports` | `report.write` |
| A report with sections, version history, and reviews | `GET …/reports/:reportId` | `report.write` |
| Write or revise a section | `POST …/reports/:reportId/sections` with `{ requestId, key, heading, body, position?, figures? }` | `report.write` |

A section is Markdown (at most 64 KiB) identified by a stable `key` such as
`methods`. Writing the same key again stores a new immutable version; earlier
versions and their reviews are kept. Figures reference output files of the
agent's own finished sandbox runs (`{ sandboxRunId, file, caption }`), and record
the file's and the script's SHA-256.

Under *Agent access → Reports* the sponsor, or a project owner or admin, reads
each section rendered (raw HTML is not rendered) with its figures, and approves
it, requests changes (with a comment), or comments. A new version needs its own
review. The agent reads the decisions and comments with `get_report` and
revises. A person finalizes the report once the latest version of every section
is approved; a finalized report cannot change. *Download Markdown* exports the
report with figure references and a provenance list. Section and review history
is append-only in the database.

## Route inventory (phase 0 gate)

Agent credentials are refused before routing by `agentCredentialGuard`
(`backend/automation/automationRoutes.js`):

| Route family | Agent credential |
| --- | --- |
| `/api/automation/v1/*` | Accepted, with per-operation authorization |
| Every other path, including `/api/projects/*`, `/api/jobs`, `/api/workflows`, `/api/expert-r/*`, `/api/private-r-kernels/*`, `/api/r/*` (R proxy), `/api/server-data/*`, `/api/artifact-versions/*`, `/api/auth/*`, uploads, and agent governance routes | `403 AGENT_ROUTE_NOT_ADAPTED` |
| Any request carrying both a session cookie and an agent credential | `400 AMBIGUOUS_CREDENTIALS` |

The check is case-insensitive and applies to malformed agent-shaped tokens.
Legacy routes authenticate only the HttpOnly session cookie, so they never
resolve an agent token. The automation API does not accept session cookies.
Agent-governance routes (`/api/projects/:projectId/agent-delegations`,
`agent-proposals`, `automation-audit`) require a signed-in person.

## Automation API

All responses are JSON with a `schema` field and `Cache-Control: no-store`.
Errors use `{ error, code, retry, correlationId }`; `retry` is `never`,
`after-delay`, `after-review`, or `same-request-id`.

| Operation | Route | Capability |
| --- | --- | --- |
| Identity, sponsor, effective capabilities, limits | `GET /api/automation/v1/context` | — |
| Project summary | `GET /api/automation/v1/projects/:projectId` | `metadata.read` |
| Datasets | `GET /api/automation/v1/projects/:projectId/datasets?limit=` | `metadata.read` |
| Completed project runs, or `?scope=mine` for this agent's runs | `GET /api/automation/v1/projects/:projectId/runs` | `results.read` |
| Submit a proposal | `POST /api/automation/v1/projects/:projectId/proposals` | `proposal.create` |
| This agent's proposals | `GET /api/automation/v1/projects/:projectId/proposals[/:proposalId]` | `proposal.create` |
| Approved releases | `GET …/projects/:projectId/workflows` | `workflow.plan` |
| Sponsor's open studies, with full trial history | `GET …/projects/:projectId/studies[/:studyId]` | `workflow.plan` |
| Create or read a plan | `POST …/plans`, `GET …/plans/:planId` | `workflow.plan` |
| Submit a plan | `POST …/runs` with `{ planId, planDigest, requestId }` | `workflow.executeApproved` |
| Run receipt and result summary | `GET …/runs/:runId`, `GET …/runs/:runId/results` | `results.read` |
| Cancel own run | `POST …/runs/:runId/cancel` | `run.cancelOwn` |
| Sponsor's open sandboxes, or one with this agent's runs | `GET …/sandboxes[/:sandboxId]` | `development.executeCandidate` |
| Run an R script in a sandbox | `POST …/sandboxes/:sandboxId/runs` | `development.executeCandidate` |
| Sandbox run state, files, console, steps; cancel | `GET …/sandbox-runs/:runId`, `POST …/sandbox-runs/:runId/cancel` | `development.executeCandidate` |
| One sandbox output file | `GET …/sandbox-runs/:runId/files/<name>` | `results.read` |
| Reports and sections | `…/reports`, `…/reports/:reportId`, `…/reports/:reportId/sections` | `report.write` |

Human routes (session only) under `/api/projects/:projectId`:
`workflow-releases`, `workflow-releases/:id/approve`,
`workflow-releases/:id/steps`, `workflow-approvals/:id/revoke`, `studies`,
`studies/:id`, `studies/:id/close`, `agent-runs`, `agent-runs/:runId/accept`,
`agent-sandboxes`, `agent-sandboxes/:id`, `agent-sandboxes/:id/close`,
`agent-sandbox-runs/:runId/review`, `agent-sandbox-runs/:runId/files/<name>`,
`agent-reports`, `agent-reports/:id`, `agent-reports/:id/reviews`,
`agent-reports/:id/finalize`, and `agent-reports/:id/export`.

A proposal request is:

```json
{ "requestId": "req-qc-0001", "kind": "code", "title": "Add a QC metric",
  "summary": "Why and what it affects", "body": "diff --git …" }
```

`requestId` is the idempotency key for that delegation: the same id and content
returns the original proposal (`200`, `replayed: true`); the same id with
different content is `409 IDEMPOTENCY_CONFLICT`. Unknown fields are rejected.
Open proposals are capped per delegation (`429 PROPOSAL_LIMIT`). Requests are
rate-limited per credential (default 60 per minute).

## CLI

`cli/traceomics.mjs` is a thin client for the automation API. It reads the
credential from `TRACEOMICS_AGENT_TOKEN` or `--token-file`, never from argv,
and refuses plain HTTP to non-local servers.

```bash
export TRACEOMICS_URL=https://traceomics.example.org
```

```bash
node cli/traceomics.mjs context
```

```bash
node cli/traceomics.mjs datasets list --project proj_example
```

```bash
node cli/traceomics.mjs proposals create --project proj_example --kind code \
  --title "Add a QC metric" --patch candidate.patch
```

```bash
node cli/traceomics.mjs plans create --project proj_example --study study_example \
  --dataset ds_example --choice clusterResolution=0.8
```

```bash
node cli/traceomics.mjs runs submit --project proj_example --plan plan_example --digest <plan digest>
```

```bash
node cli/traceomics.mjs runs results --project proj_example run_example
```

Other commands: `workflows list`, `studies list|show`, `plans show`,
`runs list [--mine]`, `runs status`, `runs cancel`.

JSON goes to stdout and diagnostics to stderr. Exit codes: `0` ok, `2` usage,
`3` credential, `4` denied, `5` not found, `6` conflict or limit,
`7` unavailable or unreachable, `1` other. Without `--request-id`, the CLI
derives one from the content (or, for `runs submit`, from the plan), so
re-running a command after a lost reply returns the original proposal or run
instead of creating a duplicate.

## MCP server

`cli/traceomics-mcp.mjs` serves the same automation API as MCP tools over
stdio, so an MCP client (an AI assistant or agent framework) can use TraceOmics
directly. Like the CLI it has no authority of its own and reads the credential
from `TRACEOMICS_AGENT_TOKEN` or `TRACEOMICS_AGENT_TOKEN_FILE`; tools never take
a credential argument.

Tools: `get_context`, `get_project`, `list_datasets`, `list_runs`,
`list_workflows`, `list_targets`, `list_studies`, `get_study`, `create_plan`,
`get_plan`, `submit_run`, `get_run`, `get_run_results`, `cancel_run`,
`create_proposal`, `list_proposals`, `get_proposal`, `list_sandboxes`,
`get_sandbox`, `run_r_script`, `get_sandbox_run`, `read_sandbox_file`,
`cancel_sandbox_run`, `create_report`, `list_reports`, `get_report`, and
`write_report_section`. `read_sandbox_file` returns PNG figures as MCP image
content, so a multimodal agent can look at its own plots. A refusal from the
server (for example `BUDGET_EXCEEDED`) comes back as a tool error with the
server's JSON. Tools that create something derive their request id from the
content, so a repeated call after a lost reply returns the original.

Example client configuration (the token file is readable only by the agent's
OS account):

```json
{
  "mcpServers": {
    "traceomics": {
      "command": "node",
      "args": ["/opt/traceomics/cli/traceomics-mcp.mjs"],
      "env": {
        "TRACEOMICS_URL": "https://traceomics.example.org",
        "TRACEOMICS_AGENT_TOKEN_FILE": "/home/agent/.traceomics-token"
      }
    }
  }
}
```

## Deployment prerequisites

The application can separate agent and human authority only if the agent
cannot obtain human credentials. Before issuing agent credentials:

- Run the agent under a separate OS account or isolated runtime. It must not be
  able to read the sponsor's browser profile, session cookies, password manager,
  SSH keys or agent socket, or this server's secrets.
- Mount only the agent token into that runtime, for example as a file read with
  `--token-file`. Do not put tokens in URLs, shell history, logs, or notebooks.
- If an agent is given a person's own login or SSH access, TraceOmics cannot
  distinguish it from that person or revoke that access.
- Revoke credentials you suspect have leaked; revocation is immediate.

## Not yet implemented

Slurm for approved job types other than the Seurat pipelines, chaining one
sandbox run's outputs into the next run's inputs (each run starts from a pinned
saved analysis), per-run OS isolation for approved workflow runs in the shared R
service, composition beyond one follow-on step, and standing acceptance rules.
Agent-specific limits do not change what people can do with their own
sessions.

## Tests

- `backend/agent-delegations.test.js`: real Express + PostgreSQL. Forged
  credentials, legacy-route refusal, mixed credentials, cross-project and
  capability scope, sponsor role loss, revocation and expiry, disclosure
  projections, idempotent and concurrent proposal submission, limits,
  immutability, audit attribution, and the CLI end to end.
- `backend/agent-capabilities.test.js`: delegations never exceed the sponsor's
  role; frozen actor contexts; fixed policy switches.
- `backend/agent-approved-runs.test.js`: the full plan → admit → lost reply →
  candidate → compare-and-swap acceptance journey; variations and joint
  constraints; changed inputs; approval separation; trial, delegation, compute,
  and racing sponsor budgets; claim-time cancellation after revocation, study
  close, or release supersession; cancellation and quarantine; the CLI.
- `backend/agent-sandboxes.test.js`: sandbox creation and input pinning, agent
  script admission and replay, budgets, claim-time cancellation, reading text
  and image outputs from a real bundle, privacy of drafts, promotion through a
  published branch, and the report write → review → revise → finalize → export
  journey.
- `backend/slurm-sandbox.test.js`: qualification against a fake Slurm that runs
  job scripts for real (passing, failing checks, settings changes), and sandbox
  runs on the cluster including reservations, console capture, and rejected
  outputs.
- `backend/readable-r.test.js`: the readable step view and the notebook form of a run.
- `cli/traceomics.test.mjs`, `cli/traceomics-mcp.test.mjs`,
  `src/pages/AgentAccess.test.jsx`, `src/pages/AgentWorkflows.test.jsx`,
  `src/pages/AgentSandboxes.test.jsx`, `src/pages/AgentReports.test.jsx`.
