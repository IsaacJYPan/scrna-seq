# Delegated agents: implementation status

This page describes what is implemented from the [agent governance design](spec.md).
The design is the target; this page is the current contract. Anything the design
describes that is not listed here as implemented is not available.

| Spec phase | Status |
| --- | --- |
| 0. Authority inventory and contracts | Implemented for the routes below |
| 1. Read-only agents and inert proposals | Implemented |
| 2. Approved local workflow execution | Not started; requests return `CAPABILITY_UNAVAILABLE` |
| 3. Qualified HPC target | Not started |
| 4. Isolated development | Not started |
| 5. Bounded protocol automation / MCP | Not started |

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
| `workflow.plan`, `workflow.executeApproved`, `run.cancelOwn` | Planned (phase 2) | — |
| `development.executeCandidate` | Planned (phase 4) | — |
| `artifact.export` | Planned (phase 5) | — |
| `workflow.approve`, `study.expand`, `result.accept`, `result.publish`, `delegation.manage` | Human-only | — |
| `security.manage`, `target.manage`, `budget.increase` | Never delegated | — |

The capability catalog lives in `backend/policy/agentCapabilities.js`.
Execution switches in the stored policy (`allowWorkflowExecution`,
`allowCandidateCodeExecution`, `allowArtifactExport`, `allowGpu`,
`allowJobArrays`) are fixed to `false`; requests to change them are rejected.

### Disclosure profiles

| Profile | Agent sees |
| --- | --- |
| `identifiers` (default) | Ids, file types, sizes, digests, statuses, timestamps |
| `labels` | Also project name/description and original filenames |

No profile exposes storage locations, dataset metadata, job parameters, logs, or
errors. Data an agent is allowed to read can still reach its model provider;
choose the profile with that in mind.

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
| Completed run summaries | `GET /api/automation/v1/projects/:projectId/runs?limit=` | `results.read` |
| Submit a proposal | `POST /api/automation/v1/projects/:projectId/proposals` | `proposal.create` |
| This agent's proposals | `GET /api/automation/v1/projects/:projectId/proposals[/:proposalId]` | `proposal.create` |
| Workflows, plans, run control | `…/workflows`, `…/plans`, `…/runs/:runId/*` | `501 CAPABILITY_UNAVAILABLE` |

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

JSON goes to stdout and diagnostics to stderr. Exit codes: `0` ok, `2` usage,
`3` credential, `4` denied, `5` not found, `6` conflict or limit,
`7` unavailable or unreachable, `1` other. Without `--request-id`, the CLI
derives one from the content, so re-running a command after a lost reply
returns the original proposal instead of creating a duplicate.

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

Study envelopes, workflow releases and approvals, execution plans, resource
reservations, candidate workspaces, result acceptance, HPC adapters, isolated
development, and MCP. Agent-specific limits do not change what people can do with
their own sessions.

## Tests

- `backend/agent-delegations.test.js`: real Express + PostgreSQL. Forged
  credentials, legacy-route refusal, mixed credentials, cross-project and
  capability scope, sponsor role loss, revocation and expiry, disclosure
  projections, idempotent and concurrent proposal submission, limits,
  immutability, audit attribution, and the CLI end to end.
- `backend/agent-capabilities.test.js`: delegations never exceed the sponsor's
  role; frozen actor contexts; fixed policy switches.
- `cli/traceomics.test.mjs`, `src/pages/AgentAccess.test.jsx`.
