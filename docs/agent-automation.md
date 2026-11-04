# Delegated agents: implementation status

This page describes what is implemented from the [agent governance design](spec.md).
The design is the target; this page is the current contract. Anything the design
describes that is not listed here as implemented is not available.

| Spec phase | Status |
| --- | --- |
| 0. Authority inventory and contracts | Implemented for the routes below |
| 1. Read-only agents and inert proposals | Implemented |
| 2. Approved local workflow execution | Implemented for one release (Seurat QC/clustering) |
| 3. Qualified HPC target | Slurm target implemented (SSH login node); site qualification pending |
| 4. Isolated development | Not started |
| 5. Bounded protocol automation / MCP | MCP server implemented; composition and standing acceptance not started |

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
| `development.executeCandidate` | Planned (phase 4) | — |
| `artifact.export` | Planned (phase 5) | — |
| `workflow.approve`, `study.expand`, `result.accept`, `result.publish`, `delegation.manage` | Human-only | — |
| `security.manage`, `target.manage`, `budget.increase` | Never delegated | — |

The capability catalog lives in `backend/policy/agentCapabilities.js`.
Switches in the stored policy (`allowArbitraryCode`,
`allowCandidateCodeExecution`, `allowArtifactExport`, `allowGpu`,
`allowJobArrays`) are fixed to `false`; requests to change them are rejected.
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

**Current limits.** Only the Seurat pipelines run on Slurm. Isolation on the cluster is
whatever the site's Slurm and container configuration enforce; site
qualification (cgroup limits, no nested submission, network policy) is still to
do. Remote commands are built from validated tokens and single-quoted; no
caller text reaches the remote shell.

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

Human routes (session only) under `/api/projects/:projectId`:
`workflow-releases`, `workflow-releases/:id/approve`,
`workflow-approvals/:id/revoke`, `studies`, `studies/:id`, `studies/:id/close`,
`agent-runs`, and `agent-runs/:runId/accept`.

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
`create_proposal`, `list_proposals`, `get_proposal`. A refusal from the server
(for example `BUDGET_EXCEEDED`) comes back as a tool error with the server's
JSON. `submit_run` and `create_proposal` derive their request id from the
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

Site qualification of the Slurm target, Slurm for other job types,
per-run OS isolation, workflow
composition, sensitivity-study selection rules, standing acceptance rules, and
isolated development. Agent-specific limits do not change what people can do with
their own sessions.

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
- `cli/traceomics.test.mjs`, `src/pages/AgentAccess.test.jsx`,
  `src/pages/AgentWorkflows.test.jsx`.
