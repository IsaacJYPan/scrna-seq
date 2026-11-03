# TraceOmics: Human-Directed Analysis and Bounded Agent Execution

| Document field | Value |
| --- | --- |
| Status | Proposed design; not a description of implemented agent or HPC support |
| Repository path | `docs/spec.md` (implementation status: [agent-automation.md](agent-automation.md)) |
| Audience | Application developers, scientific workflow maintainers, and deployment/HPC operators |
| Repository baseline | `IsaacJYPan/scrna-seq`, commit `1bbd2c84372857af6ad9282f6ba1fb82d27043d4` |

**Primary decision:** Preserve researchers' existing authority while giving agents explicit, narrower, revocable authority to perform known scientific operations.

The words **must**, **must not**, and **required** identify proposed implementation requirements. All new commands, schemas, modules, and configuration examples below are proposals. Example resource values are illustrative, not recommended cluster sizing or biological thresholds.

## 1. Executive decision

TraceOmics should be the controlled layer between a researcher's development/analysis workflow and computing resources. It should not become an unrestricted remote shell for an AI agent, nor a system that asks researchers to approve every action.

The default agent experience is:

> Inspect authorized information, select an already reviewed workflow, configure only permitted choices, run within a bounded study and resource budget, and return inspectable results without modifying the researcher's source data or accepted work.

New code is **a proposal by default**, not something the application immediately executes on the HPC. A separately enabled development lane may test proposed code in a stronger, explicitly verified isolation environment. Passing tests does not grant production execution authority. A qualified human approves a reusable workflow release once; routine executions of that release should not require repeated source-code review.

The product should distinguish five independent questions:

| Question | Controlling object |
| --- | --- |
| Who is acting, and on whose authority? | Authenticated principal and delegation grant |
| Which data may be inspected or disclosed? | Project/data permissions and disclosure profile |
| Which computation is permitted? | Approved workflow release and study envelope |
| Where and how much may execute? | Target execution profile and resource reservations |
| What may become accepted or shared work? | Explicit result acceptance and publication permissions |

These checks are cumulative. An approved pipeline is not permission to read every dataset; a human sponsor is not permission to inherit their SSH credentials; an isolated run is not a scientifically accepted result.

### Decisions to implement first

1. Give each agent a distinct principal and project-scoped delegation, linked to a responsible human.
2. Expose a narrow API and CLI over existing services; enforce the same rules below every interface.
3. Allow agent execution only of exact, server-registered, approved workflow releases and bounded parameters.
4. Keep inputs immutable and results in separate candidate workspaces; never let an agent silently modify accepted analysis state.
5. Account for all of a person's agents together, as well as each agent individually; enforce independent scheduler/runtime limits.
6. Make code proposal and execution separate capabilities. Arbitrary agent-authored code is disabled on HPC by default.
7. Review meaningful changes and exceptions, not every command or routine output.

## 2. Goals, non-goals, and success criteria

### Goals

Preserve the human researcher's ability to write scripts, use their normal development tools, and run analyses within their existing institutional permissions. Add a controlled agent path without replacing that human workflow.

Reduce the amount of new code researchers must inspect. The preferred automation is reuse and composition of trusted operations, not continual generation of bespoke scripts.

Enforce resource and data boundaries even when an agent is mistaken, follows malicious instructions from a file, retries excessively, or deliberately calls an API outside its allowed workflow. Prompt compliance is not a security dependency.

Make scientific choices, actual execution, and acceptance history inspectable without requiring a transcript of the agent's internal reasoning. Support interchangeable external agents rather than embedding a mandatory model or agent framework.

### Non-goals

This design does not promise that an HPC can never be damaged, that vetted scientific code cannot contain bugs, or that an agent cannot produce misleading interpretations. Its enforceable claims concern explicitly defined authority and execution boundaries.

It does not attempt to detect whether a human or AI physically typed a command. It does not replace HPC administration, institutional data policy, a scientific review process, or a workflow engine's scheduler. It does not require hosting a language model or building an autonomous scientist.

It does not make untrusted code safe merely by putting it in a virtual environment, a copied directory, or a container. It does not retroactively certify work performed outside the managed path.

### Success criteria

| Dimension | Desired evidence |
| --- | --- |
| Productivity | Approved routine runs complete without new approvals; researchers spend less active review time per accepted result than with ad hoc agent scripting |
| Authority | Agent credentials cannot reach human-only execution, promotion, credential-management, or administration operations |
| Containment | Tested enforcement of the declared CPU, memory, runtime, storage, filesystem, and network profile on the actual deployment |
| Accountability | Every managed run identifies its actual actor, sponsor, delegation, approved method, inputs, policy decision, resource use, and results |
| Scientific control | Agents cannot silently change the study question, protected metadata, or accepted analysis while executing an approved task |
| Recovery | Retries, lost replies, cancellation races, and worker restarts do not cause uncontrolled duplicate execution or premature budget release |

Measure safety and review burden together. A system that prevents mistakes only by creating a large approval queue has not met the product goal.

## 3. Existing foundations and limits

This design is grounded in the repository baseline above. The following are inspected foundations, not a complete security audit.

| Current area | Existing foundation | Proposed extension |
| --- | --- | --- |
| [Workflow runtime](../backend/workflowRuntime.js) and [workflow documentation](workflow-pipelines.md) | User/project authorization, validated workflow inputs, request receipts, retained outputs, and workflow state | Actor-aware authorization, approved releases, bounded plans, and agent-owned candidate workspaces |
| [Expert R access](../backend/expertRAccess.js) | `expert_r.execute`, explicit denial, and project-role/approved-account policies | Separate permission to invoke trusted workflows from permission to submit arbitrary code |
| [Job worker](../backend/jobWorker.js) and [demo admission](../backend/demoJobAdmission.js) | Durable jobs, leases/recovery, and transactional admission patterns | Shared resource ledger, remote dispatch reconciliation, and execution-time policy checks |
| [Project audit](../backend/projectAudit.js) | User-attributed, typed audit events | Actual principal plus sponsor, delegation, decision, approval, and execution identifiers |
| [Runtime readiness](../backend/runtimeReadiness.js) | Runtime/storage evidence; scheduler explicitly reported as unsupported | Target-specific scheduler and isolation capabilities with freshness and failure semantics |
| [Deployment documentation](deployment.md) | Private isolated R deployment and explicit limitations of the supported trusted-lab model | Separately qualified HPC profiles and a stronger optional development lane |
| [Recipe contract](../shared/recipePackage.mjs) | Version-2 typed recipe validation | Future bounded composition and study-policy integration |

The documented executable workflow format is version 1. Version 2 can be validated/imported but is not yet executable. Initial agent support must use supported execution paths rather than depend on completing the version-2 executor first.

The existing sandbox and desktop SSH connection features are useful building blocks, but they are not evidence that delegated agent execution or arbitrary-code HPC containment already exists. The deployment documentation explicitly does not claim a hostile-user multi-tenant security boundary.

Approval state must live on the server. Installing a package in a browser, setting a package metadata field to `trusted`, or finding a workflow in a public repository must not authorize agent execution.

## 4. User journeys

### 4.1 Routine analysis without new source review

A researcher chooses a saved dataset version, an approved Seurat workflow release, the intended study settings, a compute target, and a budget. They delegate an agent to inspect approved summaries and run that workflow.

The agent selects permitted parameters, obtains a machine-readable plan, submits it once, and observes its run. Results appear in an agent candidate workspace alongside the baseline. The researcher sees the actual method, relevant quality checks, resource use, and differences. They do not receive a new R script to audit for every execution.

Running and inspecting these results need not require another approval. Promoting them to the accepted analysis is a separate action, unless the researcher has already authorized a narrowly defined automatic acceptance rule.

### 4.2 Bounded deviations without an approval for each trial

A researcher permits a finite sensitivity analysis: a specified set of parameter combinations, an approved selection/comparison procedure, a trial limit, and a total budget. Protected study choices remain fixed.

The agent can execute that experiment independently and produce one comparison bundle containing every attempted variant, not just the most favorable result. It cannot expand the search, change the scientific objective, or discard unfavorable trials to make a result look stronger.

### 4.3 New code without immediate HPC execution

An agent encounters a missing capability. It creates a proposal containing the code difference, intended behavior, affected method/data contracts, suggested tests, and expected resource impact. Uploading this proposal is inert.

By default, a human reviews it before any execution. Where the separate development capability has been enabled, the agent may run bounded tests using approved fixtures in an isolated development environment. The resulting evidence can reduce review effort, but does not replace code/method review or authorize production use.

Approval creates an immutable workflow release with a defined scope. It does not install the patch into a researcher's existing environment or overwrite accepted analysis files.

### 4.4 Human expert work remains available

A human researcher may keep using their existing R console, scripts, notebooks, SSH workflow, and development environment as their existing permissions allow. Agent-specific quotas and approved-workflow restrictions do not automatically apply to those human sessions.

Institutional limits, ordinary project permissions, and platform-wide safety constraints still apply. Direct human HPC work is outside TraceOmics' enforcement boundary unless routed through it. Imported results from that work are labeled as externally supplied evidence, not falsely attributed to a managed execution.

## 5. Threat model and enforceable boundary

### 5.1 What the application must assume

An agent may ignore instructions, misread a dataset, invent a tool call, retry a non-idempotent operation, attempt a larger parameter sweep, or encounter prompt injection in a README, log, annotation, or result. An agent may also receive a malicious workflow package or executable-looking output.

Treat the agent client and its requested operation as untrusted input. Treat generated source, output files, claimed provenance, and model-written explanations as untrusted until processed by the relevant validation path.

The trusted computing base includes authentication/authorization code, the policy evaluator, release registry, budget ledger, execution broker, approved runner, artifact validators, and the site's enforcement configuration. These components must not be editable by the agent.

### 5.2 Identity is credential provenance, not AI detection

A request is classified by the credential and delegated authority that authenticated it. The server must not trust `isAI`, `actorKind`, a user-agent string, a CLI switch, or an agent's claim that a human approved the action.

An agent using a human's unrestricted session is indistinguishable from that human at the application boundary. Consequently, meaningful separation requires that the agent cannot obtain the human session, SSH key, SSH-agent socket, approval credential, or broker secret.

Merely omitting those credentials from a tool description is insufficient. An agent process with the same unrestricted filesystem and OS identity as the human may still reach them. Deployment guidance must prescribe a separate agent account or genuinely isolated agent runtime with narrowly mounted credentials and no access to the human's browser profile or credential stores.

Human-only approval must happen through a separately authenticated channel unavailable to the agent. Strong reauthentication can strengthen this boundary, but a confirmation dialog inside a browser the agent can operate is not proof of human involvement.

### 5.3 Boundary conditions

The application can enforce limits only where it completely mediates access. Managed agent workloads must not have an alternate path to submit jobs, mutate shared source, or acquire broader data access.

If a user deliberately gives their agent full personal SSH access, TraceOmics cannot revoke that external authority or distinguish the resulting HPC commands. The UI and deployment documentation must state this rather than suggest that an agent badge provides protection.

A compromised platform administrator, host kernel, or cluster administrator is outside the initial containment claim. Approved code can still contain scientific or implementation defects. The objective is a bounded, testable failure domain, not a universal guarantee.

## 6. Architecture

```text
Human UI / human CLI                      External agent / agent CLI / MCP
        |                                            |
 human credential                         delegated agent credential
        +----------------------+---------------------+
                               |
                  Authentication -> ActorContext
                               |
             Shared application services and policy evaluation
              |             |             |              |
         Data access   Release trust   Study limits   Resource ledger
                               |
                  Immutable admitted execution plan
                               |
                    Durable queue / dispatch outbox
                               |
                Restricted execution broker / adapter
                               |
             Site scheduler + OS/runtime enforcement
                               |
              Per-run candidate workspace and outputs
                               |
                 Quarantine -> validate -> inspect
                               |
                   Separate acceptance/publication
```

CLI, MCP, browser, and REST clients must use the same authorization and admission services. MCP is an optional adapter, not a new execution authority. Do not implement safety only in the CLI.

The broker receives a sealed plan or a plan identifier authenticated to the service, not an arbitrary command string. It retrieves approved code and input identities from controlled storage. Workload processes receive neither the sponsor's credentials nor the broker's submission authority.

Prefer incremental modules within the existing Express/PostgreSQL/worker architecture. A separate policy microservice, general-purpose policy language, or replacement job scheduler is not necessary for the first release.

## 7. Principals, delegation, and permissions

### 7.1 Separate identity, sponsorship, ownership, and approval

| Concept | Meaning |
| --- | --- |
| Principal | The authenticated human, agent, or platform service actually performing an action |
| Sponsor | The responsible human whose current authority bounds a delegated agent |
| Delegation | An explicit, versioned grant of a subset of capabilities, data, targets, and budgets |
| Workspace owner | The project/human that owns retained research material; not a substitute for identifying its actor |
| Approver | The authorized human who approved a particular release, study change, or result acceptance |

Do not create an ordinary analyst user for an agent and copy the sponsor's permissions. Do not collapse the agent back to `userId` before entering existing services.

All sensitive services should receive an authenticated `ActorContext` with stable principal identity, sponsor where applicable, delegation ID/version, credential identity, and request correlation. Only trusted authentication code constructs this context. Platform services must also preserve the originating principal and delegation when executing an admitted plan; record the executor service separately. Routing an agent request through a trusted worker must not turn it into an unrestricted service action.

Conceptually:

```text
agent authority = current sponsor authority
                intersect explicit delegation
                intersect project/data policy
                intersect approved workflow/study scope
                intersect target capabilities and remaining budgets
```

Explicit denial or revocation wins. Any unknown required fact denies execution. Resource limits compose at every applicable level, not only the lowest level.

Separate the capability to run an approved workflow from the capability to supply arbitrary R. A human permitted to run a reviewed analysis should not need to delegate unrestricted `expert_r.execute` merely because the underlying implementation evaluates R in a trusted runner.

### 7.2 Initial capability model

| Capability | Default agent behavior |
| --- | --- |
| `metadata.read` / `results.read` | Explicit project/data scope; bounded projections |
| `workflow.plan` | Approved releases and authorized inputs only |
| `workflow.executeApproved` | Explicit grant; study and resource limits apply |
| `run.cancelOwn` | Only runs linked to this delegation; no arbitrary scheduler IDs |
| `proposal.create` | Inert code/method proposals; bounded size and number |
| `development.executeCandidate` | Off by default; requires separate grant, fixtures/data scope, and verified target profile |
| `artifact.export` | Separate grant with destination/disclosure policy |
| `workflow.approve` / `study.expand` | Human-only, with explicit project capability |
| `result.accept` / `result.publish` | Human-only by default; narrow standing rules may permit automated acceptance, not self-approval |
| `security.manage` / `target.manage` / `budget.increase` | Never granted to agent credentials |

A human project role is still relevant, but is not a blanket grant for all governance actions. The person reviewing methods may differ from the operator administering a compute target.

Initial agents cannot create more agents or redelegate. A later subagent feature must inherit the same parent budget and cannot expand authority.

### 7.3 Credential and revocation semantics

Use revocable, project-scoped credentials with explicit expiry and audience. For an initial deployment, opaque high-entropy tokens stored as hashes server-side are simpler than a new federated identity system. Never put tokens in URLs, analysis artifacts, logs, or command examples containing real values. Standards-based delegation can be added later; RFC 8693 explicitly distinguishes delegation from impersonation. [S1]

Every authorization rechecks the current delegation and sponsor membership. Credential expiry blocks subsequent API use. It is distinct from the lifetime of an already admitted run: that run has a bounded execution permit, not the agent's bearer token.

Default delegation revocation or delegation expiry blocks queued dispatch and requests cancellation of unfinished delegated runs. Already completed artifacts remain owned by the project/human, subject to normal access rules. A late completion after revocation is quarantined and cannot automatically advance a branch or become accepted work.

A kill switch must support disabling one agent, all of a human's delegations, a project, a workflow release, or a target. A network failure may delay physical cancellation; the UI must report that uncertainty honestly.

## 8. Trusted workflows, study envelopes, and bounded deviations

### 8.1 Approve executable content, not a name

A `WorkflowRelease` should pin the package/source digest, runner/compiler version, environment image or exact environment manifest, transitive helper/subworkflow identities, parameter schema, declared inputs/outputs, resource profile, and validation contract. For built-in handlers, the approved identity also includes the versioned handler implementation.

Approval is a separate server-owned record binding that release to a scope: allowed project(s), input/data profile, targets or isolation profiles, parameter choices, and approval/revocation policy. Package authors cannot approve their own package through metadata.

The execution closure matters. A pinned script that downloads mutable code, loads a helper from a writable directory, runs an unpinned subprocess, or reads a user startup file is not a pinned method. Managed runs must use fixed entrypoints, reviewed dependencies, controlled startup configuration, and no runtime installation from arbitrary registries.

An approved wrapper around arbitrary evaluation is still arbitrary-code execution. Agent-eligible operations must not accept R/Python source, shell fragments, unrestricted file paths, or mutable module locations disguised as ordinary parameters. Use named approved designs or narrowly parsed declarative inputs instead. Any executable parameter surface belongs in the separately governed code-development/human-expert lane.

A new source, dependency, runner, or protected contract digest creates a new release identity. Changes outside an existing approval's scope need new authorization. An ordinary service restart does not invalidate a release when its relevant executable identities are unchanged.

### 8.2 A study envelope preserves the researcher's intent

A `StudyEnvelope` is the finite scientific and operational space in which an agent may work. It should bind:

- Exact input versions and permitted cohort/sample identities.
- Approved workflow releases and allowed graph structure.
- Protected choices such as contrasts, biological unit, condition labels, covariates, or normalization strategy where the protocol requires them.
- Explicit parameter alternatives, cross-parameter constraints, and applicability checks.
- A maximum number of trials and an approved comparison/selection rule.
- Compute, storage, time, and disclosure budgets.
- Stop conditions and result-acceptance policy.

The app does not need to understand all biology. Workflow maintainers declare machine-checkable constraints and protected scientific choices, while the researcher chooses an appropriate protocol. Without a declared permission to vary a field, the agent cannot vary it.

Numeric bounds alone are insufficient. Two individually allowed parameters may be invalid in combination. A workflow may be approved for one assay, organism, data layer, or study design and not another. Validate these prerequisites against versioned metadata before admission; do not silently guess missing design facts.

### 8.3 Classify changes by semantics, not code size or model confidence

| Change class | Default treatment |
| --- | --- |
| Read existing authorized summaries | Automatic, subject to disclosure and read budgets |
| Repeat an approved run with identical scientific settings | Automatic within repeat/trial policy and budget |
| Change a permitted display-only option | Automatic through a vetted rendering operation; retain scientific inputs |
| Choose within an approved finite parameter envelope | Automatic; record the choice and count the trial |
| Compose approved steps | Only through an approved template with validated bindings; trusted nodes do not automatically make every graph trusted |
| Change a protected study choice, dataset/cohort, or method | Create one scoped amendment proposal; do not execute the amendment |
| Add/modify source or dependencies | New candidate release; no production execution without approval |
| Change quotas, permissions, acceptance rules, or target configuration | Human/operator governance path only |

Never use the number of changed lines, an agent's explanation, or a second model's assessment as the authorizing condition. A one-line change can alter the scientific method or permit arbitrary execution.

### 8.4 Avoid turning flexibility into uncontrolled search

Bound the total experiment, not only each individual call. Every new trial, repeat, seed, and permitted retry belongs to the same study ledger. Creating new request IDs or agents does not reset that ledger.

Do not let an agent search indefinitely for significance, a preferred clustering, or a visually pleasing result. Record all attempts and selection criteria. Any permitted adaptive branching must itself be defined in the approved procedure, with finite stopping rules and retained decisions. Otherwise, stop and request a study amendment.

No universal QC thresholds are prescribed here. A lab-approved protocol should provide appropriate values and exceptions; the platform's job is to enforce that protocol and expose deviations.

## 9. Execution lanes and the code-development boundary

Execution lanes are capability combinations, not a single slider called "trust the AI."

| Lane | Code and data | What the agent may do | Acceptance |
| --- | --- | --- | --- |
| Inspect | Authorized retained metadata/results | Read bounded summaries; propose next steps | No computation or scientific state mutation |
| Approved analysis | Approved release; authorized immutable study inputs | Run approved operations and permitted variants | Candidate results; no new code review per run |
| Proposal only | Unreviewed source retained as text | Draft code, method changes, and evidence requirements | Human review before execution by default |
| Isolated development | Unreviewed candidate; approved fixtures or explicitly granted data | Run bounded tests on a separately qualified target | Tests do not authorize production use |
| Human expert | Human-authorized ad hoc work | Existing human development capabilities | Human accountability; no implied workflow certification |

### Development defaults

Enable proposal-only functionality before enabling agent-generated code execution. The default agent cannot install packages, invoke a shell, open a private R kernel, or submit a custom `expert.r` script.

An optional development target must be qualified separately from the normal analysis target. Use synthetic or approved non-sensitive fixtures first. Access to real research data is an additional grant, not a consequence of having code-development access.

The development environment must have no production credentials, accepted-work write mounts, broad shared data mounts, or ability to submit nested jobs. Builds are also code execution: package installation hooks, container builds, tests, and environment creation must not run in a privileged broker or production control-plane process.

Prefer prebuilt reviewed environments and a finite dependency catalog. A new dependency becomes a separate review/build request. The development agent must not update its own resource policy, reference baselines, acceptance tests, or release approval records.

### Promotion

A development proposal becomes an approved release only after an authorized review of the immutable candidate and its declared scope. Tests can establish specified properties; they do not establish general scientific validity or absence of malicious behavior.

For low-risk changes to an already reviewed module, the review UI should focus on the exact semantic/source difference and trusted test evidence. For a genuinely new method, substantive human review remains necessary. The product should reduce repeated review, not disguise novel methods as routine work.

## 10. HPC isolation, environments, and candidate workspaces

### 10.1 Three different forms of isolation

| Mechanism | Purpose | What it does not establish by itself |
| --- | --- | --- |
| Python virtual environment, Conda environment, or R library environment | Reproducible/separate dependencies | Filesystem, network, process, credential, or scheduler containment |
| Separate directory, Git worktree, snapshot, or copy-on-write workspace | Keep candidate changes apart from accepted work | OS permission separation or resource limits |
| Site-qualified container/OS execution profile | Enforce an explicitly configured runtime boundary | Scientific correctness, automatic data declassification, or immunity to host vulnerabilities |

Python's `venv` isolates installed packages around an interpreter; it is not an execution permission boundary. [S2] Use dependency environments inside the execution profile when appropriate, never as a substitute for it.

For HPC, support the container/runtime the institution permits, potentially Apptainer. Do not treat default Apptainer execution as a locked-down sandbox: its documented default mounts include the home and working directories, and user-controlled bind settings exist. [S3] The adapter must implement and test a site-specific profile rather than blindly invoke a universal container command.

### 10.2 Required target execution profile

A `TargetExecutionProfile` describes the actual allowed execution environment. It includes:

| Property | Required managed behavior |
| --- | --- |
| Identity | Site-approved execution principal with no administrator privileges; sponsor-to-account mapping controlled by the operator |
| Code | Exact approved image/environment and runner identity; no mutable tags as the sole identity |
| Input access | Only declared, versioned inputs mounted read-only |
| Writable storage | Per-run scratch/output and explicitly bounded private caches only |
| Credentials | No human home, SSH socket/key, cloud token, database credential, container-daemon socket, or broker submission secret |
| Startup/configuration | Clean allowlisted environment; controlled R/Python startup, paths, and import/library locations |
| Network | No workload egress by default; any exception has a declared endpoint/purpose and site-enforced policy |
| Resources | Enforced CPU, memory, processes, wall time, storage bytes/inodes, and relevant device restrictions |
| Scheduler access | No alternate/nested submission route from a workload |
| Cancellation | A tested way to terminate the whole job/process tree and establish terminal state |
| Observability | Profile version, enforcement evidence, runtime/scheduler identifiers, and freshness timestamps |

Slurm provides mechanisms for limiting submitted/running jobs and allocated resources, but configuration and limit precedence matter. Do not assume that specifying a job request or taking the minimum of every displayed QOS setting produces the intended site policy. [S4] Memory, CPU, and device confinement also depends on the configured task/cgroup behavior; verify it rather than infer it from `--mem` or a successful submission. [S5]

Readiness must report individual verified capabilities, not one ambiguous `safe: true` flag. Missing mandatory enforcement disables the corresponding lane. A target suitable for approved code is not automatically suitable for unreviewed development code. A stronger VM or separate managed development service may be needed where the cluster cannot provide the required boundary.

### 10.3 Immutable inputs and disposable candidate work

Each run gets a server-generated workspace, for example:

```text
runs/<run-id>/
  input/       # selected immutable versions, read-only
  work/        # temporary scratch under enforced quota
  output/      # declared candidate outputs under enforced quota
  receipts/    # trusted broker records; not workload-writable
```

Do not copy an entire lab filesystem or duplicate large datasets by default. Use versioned immutable artifacts, storage snapshots, or verified staging of selected files. A read-only bind is insufficient for reproducibility if another process can change the underlying source. Prevent that mutation through storage ownership/versioning or stage a stable version and verify its digest.

Hard links to writable originals are not independent copies. A copy-on-write workspace is useful only when its backing data and access controls actually preserve the baseline. Failed runs or cleanup must never remove a shared input, another run's output, or the researcher's active environment.

The run root, control records, and parent directories must be broker-owned and not writable by the workload; only the declared scratch/output locations are writable. Use OS identity and process-namespace controls sufficient to prevent cross-run signaling, process inspection, and modification. A shared host UID plus different directory names is not proof of isolation.

An agent's workspace must not reuse the sponsor's live R session or active mutable workflow instance. The agent can read authorized snapshots, not silently advance the human's current working object.

Accepting a result means promoting an immutable artifact reference or moving a versioned branch pointer. It does not mean copying an entire candidate filesystem over the original directory. Rollback can restore a reference; it cannot undo compute expenditure or previously disclosed data.

### 10.4 Scheduler/SSH integration

Choose one institution-approved adapter initially. For Slurm, either a private authenticated `slurmrestd` integration or an operator-installed restricted gateway may be suitable. Slurm's documentation explicitly cautions against directly exposing its REST service to the internet; keep it behind the site's authentication and network boundary. [S6]

For an SSH gateway, use a dedicated restricted identity and a fixed gateway executable accepting a bounded structured request. A forced command must be paired with the necessary forwarding restrictions; `ForceCommand` alone does not disable forwarding. [S7] Do not evaluate `SSH_ORIGINAL_COMMAND`, concatenate caller-supplied shell syntax, or expose arbitrary `ssh exec`, `scp`, or SFTP to agents.

Keep the human desktop tunnel and the restricted job gateway as distinct credential/policy paths. A credential intended for application tunneling is not the agent's general cluster credential.

Workload code must also be unable to bypass the broker from a compute node. Hiding `sbatch` from `PATH` is not sufficient. The site must address scheduler RPC/network reachability, authentication sockets such as MUNGE where applicable, execution identity, and submission policy. If that cannot be established, do not enable unreviewed code on that target.

Honor the site's account-sharing and user-attribution rules. Do not invent a shared superuser submitter merely to simplify integration. Site-managed per-user delegation or narrowly scoped execution accounts are deployment options, not assumptions.

## 11. Resource admission and budgets

### 11.1 Hierarchical accounting

All applicable limits must be satisfied:

```text
installation / target capacity
  -> project budget
    -> sponsoring human's managed-work budget
      -> aggregate budget for all that human's agents
        -> individual delegation budget
          -> study/trial budget
            -> run maximum
```

Human interactive work may have a separate reserve or queue priority so automation does not consume its entire allocation. Human work and agent work still share physical capacity. Direct human jobs outside TraceOmics are visible only to the extent the scheduler/site exposes them; scheduler limits remain the authoritative backstop.

Track outstanding submissions, executing/possibly executing jobs, aggregate reserved CPU and memory, GPU allocations, wall time, allocated CPU/GPU time, scratch/retained bytes, inode counts, retry count, and study trial count. Rate-limit planning, polling, artifact reads, and proposals as well. Read-only requests can still overload storage or the scheduler.

Initial agent execution should disable arrays, heterogeneous jobs, arbitrary dependencies, and nested submission. A future array/scatter feature must count its full expanded work and maximum parallel resources, not treat an array of thousands of tasks as one job.

### 11.2 Example policy, not deployment defaults

```json
{
  "schema": "traceomics.delegation-policy.v1",
  "mode": "approved-workflows",
  "maxOutstandingRuns": 5,
  "maxRemoteNonterminalJobs": 2,
  "maxReservedCpus": 8,
  "maxReservedMemoryGiB": 32,
  "maxCpusPerRun": 4,
  "maxMemoryGiBPerRun": 16,
  "maxWallSecondsPerRun": 3600,
  "maxAllocatedCpuSecondsPerStudy": 57600,
  "maxTrialsPerStudy": 4,
  "maxRetriesPerRun": 0,
  "maxScratchGiBPerRun": 10,
  "maxRetainedGiBPerStudy": 20,
  "allowGpu": false,
  "allowJobArrays": false,
  "allowCandidateCodeExecution": false,
  "allowArtifactExport": false
}
```

This example is deliberately conservative and may be too small for real scRNA-seq workloads. UI estimates must disclose uncertainty and distinguish requested, reserved, allocated, and measured resources. Estimates are advisory; hard ceilings are enforced independently.

### 11.3 Atomic reservation rules

Admission must atomically validate applicable limits, reserve capacity, create the immutable plan/run receipt, and enqueue dispatch in the same database transaction. Lock budget rows in a consistent order or use equivalent concurrency-safe ledger operations. A route-level `COUNT` followed by an unprotected insert is not sufficient.

Use two admission stages: bounded local outstanding work, then a remote execution reservation before submission. For an initial implementation, count remote pending and unknown jobs against the same conservative remote cap as running jobs. This sacrifices some utilization but avoids releasing capacity while remote work may still start.

Reserve cumulative compute against the maximum admitted allocation, such as CPUs multiplied by maximum runtime, not an optimistic estimate. Reconcile against trusted accounting where available. Keep conservative charges when final accounting is unavailable; manual reconciliation must be explicit and audited. Do not release real usage merely because a job failed or was canceled.

Unknown remote state retains its reservation. A worker lease expiry is not proof that the scheduler job ended. Rolling-period budgets must carry outstanding liabilities across the period boundary instead of resetting active work to zero.

An approved fallback to a larger resource tier may be automatic only if the study policy explicitly allows it and a new reservation succeeds. An out-of-memory error must not silently authorize more memory, a new partition, or unlimited retries. Failure recovery must also not silently drop cells/samples, change precision, or substitute a scientific method to make a run succeed; those changes require explicit study authorization.

## 12. Planning, execution, cancellation, and recovery

### 12.1 Immutable execution plans

The server resolves a request into an immutable `ExecutionPlan` containing the actor/sponsor/delegation identities, policy versions, approved release, input versions, study envelope, normalized parameters, seed, target/profile, requested resources, declared outputs, validation rules, and execution deadline.

A plan digest covers the complete canonical specification, including defaults. Store the canonical bytes with their digest; define deterministic serialization and reject unknown fields. A plan never contains a hidden arbitrary-code escape hatch.

Planning is not permission to execute. At admission and again before remote dispatch, recheck current membership, delegation, approval/revocation, input access, budget, and target readiness. A stale or changed plan returns a structured error rather than silently substituting a new method or target.

### 12.2 Logical lifecycle

Keep execution phase, result validation, and scientific acceptance separate. The following is a proposed logical lifecycle, not a replacement for every existing database status value:

```text
planned -> admitted -> dispatching -> remote_pending -> running
                           |                             |
                           v                             v
                  dispatch_uncertain                collecting
                           |                             |
                     reconciliation                     v
                                                    validating
                                                        |
                                                        v
                                                candidate_ready
                                                        |
                                                explicit acceptance
```

Failure, cancellation, and quarantine can occur along the path. `candidate_ready` means outputs passed the declared technical checks, not that the science is correct. Accepted/published status belongs to a separate record.

### 12.3 Idempotency and remote uncertainty

Use a unique idempotency key scoped to principal, delegation, project, and operation. The same key and request digest returns the original receipt; the same key with a different request is rejected. A new key does not evade study limits.

Persist dispatch intent and a broker submission key before contacting the scheduler. The broker must durably associate that key with the plan and remote job identity, serialize concurrent submissions for it, and expose a reconciliation operation.

A network failure can occur after the scheduler accepted a job but before the broker recorded its ID. Do not claim exactly-once execution across that boundary without a proven scheduler-supported protocol. Mark the attempt uncertain, retain reservations, and search/reconcile using trusted scheduler evidence and the submission identity. Scheduler visibility may be delayed; a temporarily empty query is not proof that no job exists.

If the adapter cannot conclusively reconcile an ambiguous submission, block automatic redispatch and request operator resolution. A unique job name or comment is useful correlation evidence, not an authorization or exactly-once guarantee.

Worker fencing prevents stale workers from publishing or replacing results. It does not itself stop an old remote job; scheduler reconciliation remains necessary.

### 12.4 Cancellation and revocation

Cancellation is a request, not an immediate terminal observation. Record `cancel_requested`, issue the idempotent target cancellation, and wait for confirmed termination of the relevant job/process tree. Retain capacity while its state is unknown.

Bind remote job IDs to target identity, submission/attempt identity, scheduler owner, and relevant creation evidence. Validate that binding before canceling; never accept a caller's arbitrary scheduler job ID. Agents may cancel only their own authorized runs, not all jobs charged to their sponsor.

Disconnecting the CLI, closing an SSH tunnel, or expiring an API token does not establish that a job stopped. Conversely, routine client disconnection should not discard a legitimate admitted run.

Late outputs after revocation, cancellation, or a superseded attempt cannot advance accepted or working analysis state. Preserve them only under an explicit quarantine/retention policy.

### 12.5 Failure policy

| Event | Required behavior |
| --- | --- |
| Policy/budget database unavailable | No new admissions or dispatch; bounded existing jobs remain under site limits |
| Scheduler or broker unreachable | Back off, retain reservations, report unknown; do not spawn replacement jobs |
| Revoked grant/release or lost sponsor membership | Block dispatch; request cancellation according to the defined revocation policy; block automatic publication |
| Validation failure | Quarantine outputs; retain the previous result |
| Worker restart or duplicate delivery | Recover the original receipt/dispatch identity; do not treat it as a new trial |
| Excessive failed requests or retries | Apply rate limits/circuit breaker; do not flood the human approval queue |
| Storage nearing reserve threshold | Stop admissions and controlled staging; preserve retained evidence and source data |

Security-relevant decisions and state transitions must be durably recorded. If that record cannot be committed, do not proceed with the associated mutation or dispatch. Keep narrowly authenticated operational cancellation available during a control-plane outage, with local durable receipts for later reconciliation.

## 13. Results, data disclosure, and acceptance

### 13.1 Outputs are not automatically trusted

Collect outputs into quarantine before making them normal project artifacts. Validate declared names, types, sizes, counts, checksums, schemas, and resource-bounded previews. Enforce filesystem containment against traversal, symlinks, hard-link abuse, special files, and archive expansion. Do not deserialize an untrusted RDS/pickle-like object inside the control plane merely to preview it.

The workload must stop writing before trusted collection seals its outputs. Prevent post-validation mutation through ownership/access changes or copying to immutable managed storage; record hashes of the sealed bytes. The trusted broker produces execution receipts. A script writing `passed: true` is not sufficient evidence that an independent validator ran.

Treat logs, annotations, filenames, notebooks, and proposal text as data rather than instructions. Render code and textual evidence inertly; do not execute HTML, notebook cells, macros, or embedded commands to show a review screen.

### 13.2 Compute permission is different from disclosure permission

An agent can be authorized to request a computation without being authorized to download its raw inputs. The broker can mount approved data while returning only the allowed result projection.

Define output visibility by delegation: permitted metric fields, table columns, row limits, identifiers, downloadable artifacts, and export destinations. Do not assume that a summary, embedding, or aggregate is automatically non-sensitive. Derived results retain their input sensitivity unless an approved transformation and data policy state otherwise.

Network-isolating HPC jobs does not prevent an external AI client from sending visible results to its model provider. Therefore the authorization to reveal data to that agent must be explicit. TraceOmics should default to narrow metadata/summary access and should not imply it can control data after an authorized external client receives it.

### 13.3 Acceptance is separate from execution and sharing

Maintain separate facts: source trust, execution evidence, validation outcome, scientific acceptance, and sharing/publication status. Avoid one combined `approved` badge.

Default acceptance changes a branch pointer or retained analysis reference only after an authorized human reviews the exact candidate version. Use compare-and-swap against the expected baseline so an old approval cannot overwrite newer human work. Human acceptance does not automatically authorize public export or approve the pipeline for other studies.

A later standing acceptance policy can automatically retain or advance clearly specified low-risk results. That rule must be approved independently, bind exact validators and applicability criteria, and be evaluated by trusted code. The agent cannot author the rule and then use it to accept its own results. External publication remains a separate capability.

## 14. Review design: fewer, better decisions

Use three review units: a workflow release, a study envelope/amendment, and an exceptional result. Do not create one approval per low-level tool call.

The server should assemble an evidence bundle from actual plan, execution, and artifact records. Include the baseline/candidate identity, exact changed method fields or source diff, affected inputs/cohort, trial history, relevant metrics/plots, validation outcome, resource impact, and the specific authority being requested. Include the agent's concise rationale as attributed commentary, not as the authoritative record.

Approval must bind the reviewed digest and scope, expected baseline, expiry where applicable, and a one-time or reusable use policy. A modified candidate, changed input, stale baseline, or expanded scope invalidates that approval. An approval note saying "looks good" must not become permission for unrelated future operations.

Make no-change reuse, parameter-only changes, and actual source changes visibly different. Aggregate related trial results into one comparison. Deduplicate amendment requests and cap outstanding proposals so an agent cannot create review fatigue by repeatedly asking for broader authority.

Trusted acceptance tests belong to reviewed releases or platform validation suites. Candidate code cannot modify the reference outputs/tolerances or substitute its own test results. Use declared numerical tolerances and invariant checks where byte equality is inappropriate; record environment and nondeterminism limitations rather than asserting universal reproducibility.

Useful product metrics include active researcher review time, approvals per completed study, percentage of runs requiring no new approval, duplicate execution incidents, policy violations blocked, and time to recover uncertain jobs. Do not optimize only for the number of agent actions completed.

## 15. API, CLI, and optional MCP interface

### 15.1 Proposed surface

Expose a small versioned automation API backed by shared services. These routes are illustrative, not existing endpoints.

| Operation | Proposed route | Important constraint |
| --- | --- | --- |
| Inspect effective identity/capabilities | `GET /api/automation/v1/context` | Server-derived identity; no credentials in the response |
| Inspect available approved releases | `GET /api/automation/v1/projects/:projectId/workflows` | Only visible releases/scopes |
| Create/read a plan | `POST /api/automation/v1/projects/:projectId/plans` | Approved release and artifact IDs, never arbitrary command/source |
| Submit a plan | `POST /api/automation/v1/projects/:projectId/runs` | Exact plan digest plus idempotency key |
| Read run/receipt/events | `GET /api/automation/v1/projects/:projectId/runs/:runId` | Current actor/data authorization; bounded polling/events |
| Cancel a run | `POST /api/automation/v1/projects/:projectId/runs/:runId/cancel` | Own delegated run; durable cancellation receipt |
| Inspect candidate output | `GET /api/automation/v1/projects/:projectId/runs/:runId/results` | Approved projection, not unrestricted filesystem access |
| Create a proposal | `POST /api/automation/v1/projects/:projectId/proposals` | Inert source/metadata; does not execute or approve it |

Human-only governance operations use separate capabilities and reject agent credentials, even when the sponsor owns the project. Their implementation may reuse the same underlying records and services.

A submitted execution request might be:

```json
{
  "schema": "traceomics.run-request.v1",
  "planId": "plan_qc_example",
  "planDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "requestId": "610b8789-67f9-41e9-99f0-16e74a348df0"
}
```

The digest is an illustrative placeholder. The server resolves the actor, approved source, inputs, target, resources, and approval scope from trusted records; the caller cannot substitute those identities in the submission body.

Responses should use stable error codes, an operation/request identifier, a policy decision reference, bounded safe context, and retry guidance. Useful codes include `SCOPE_DENIED`, `RELEASE_NOT_APPROVED`, `STUDY_AMENDMENT_REQUIRED`, `BUDGET_EXCEEDED`, `TARGET_UNQUALIFIED`, `PLAN_STALE`, `SUBMISSION_UNCERTAIN`, and `RATE_LIMITED`. Retry guidance must not encourage a new submission when the original outcome is unknown.

### 15.2 Agent-facing CLI behavior

```bash
# Proposed commands; not implemented by this document.
traceomics context --json
traceomics workflows list --project prj_example --approved --json
traceomics datasets inspect --project prj_example --version data_v1 --json
traceomics plans create --study study_qc --workflow release_qc --input data_v1 --json
traceomics runs submit --plan plan_qc_example \
  --request-id 610b8789-67f9-41e9-99f0-16e74a348df0 --json
traceomics runs status run_example --json
traceomics runs results run_example --json
traceomics proposals create --study study_qc --patch candidate.patch --json
```

Machine-readable output must have a versioned schema. JSON goes to standard output; progress/diagnostics go to standard error. Define stable exit codes, pagination, byte limits, and cancellation behavior. A noninteractive command must never silently log in as a human or wait on an unbounded approval prompt.

A dry run can validate and plan, but must not allocate HPC resources or load large objects into an unbounded process. Expensive inspection is a separately admitted operation, not a supposedly harmless read endpoint.

Submitting returns a durable run/receipt ID. Waiting or reconnecting observes that run; it never reissues a submission under a fresh identity. CLI convenience settings cannot bypass server policy.

MCP tools should map one-to-one to these capabilities, using the same token scope and structured contracts. Do not add a generic shell, SSH, Python/R evaluation, unrestricted filesystem, or package-install tool for convenience.

## 16. Persistence and service integration

### 16.1 Proposed records

Extend existing jobs, artifacts, workflow snapshots, and analysis branches rather than create parallel versions of all of them. Add normalized records where the existing model cannot represent delegated authority:

| Record | Essential information |
| --- | --- |
| `agent_principals` | Stable agent identity, sponsor, lifecycle status; optional descriptive model/client metadata that never grants authority |
| `delegations` / `delegation_credentials` | Project, capabilities, data/disclosure scope, policy version, expiry/revocation, credential hash/audience |
| `workflow_releases` / `workflow_approvals` | Immutable executable identities/contracts; separate human approval, scope, evidence, and revocation |
| `study_envelopes` | Versioned protected design, allowed variation, trial/selection policy, budgets, and acceptance policy |
| `execution_plans` | Canonical admitted specification/digest, actor context, approval references, and expected baseline |
| `resource_reservations` / `resource_usage_events` | Hierarchical reservations, consumed usage, reconciliation, and durable releases |
| `dispatch_attempts` | Submission key, fencing token, target/profile, scheduler mapping, uncertain/terminal observations |
| `change_proposals` | Immutable candidate versions, source/semantic differences, review state, and scoped approval linkage |
| `result_acceptances` | Exact result and expected baseline, human or preapproved rule, decision evidence, and new accepted reference |

Audit events and run records must preserve both `actorPrincipalId` and `sponsorUserId`, plus delegation/policy identities. Historical records must not silently rewrite an agent action as a human action. Preserve history after credential deletion or delegation revocation. Existing rows that only identify a user session should remain explicitly legacy/actor-unverified; do not backfill them as verified human actions. New origin and executor identities must be distinct where a platform service performs the work.

Use database constraints for idempotency, immutable identities, project-scoped relationships, and unique remote submission mappings. Protect approvals and retained evidence from workload writes. Validate actor/project relationships on every read and write, including receipt recovery and export paths.

### 16.2 Recommended module boundaries

These are suggested new modules, not required filenames:

```text
backend/actors/              # authentication context and delegation lifecycle
backend/policy/              # deterministic operation authorization
backend/workflowTrust/       # releases, approvals, and applicability
backend/studyEnvelopes/      # protected design and bounded variations
backend/resourceAdmission/  # reservations, trial counts, and usage reconciliation
backend/executors/           # local and site-approved scheduler adapters
backend/proposals/           # inert code changes, evidence, and review
cli/                         # thin authenticated client
```

Integrate them with `backend/workflowRuntime.js`, `backend/jobWorker.js`, `backend/expertRAccess.js`, `backend/projectAudit.js`, and runtime readiness. Reuse the existing workflow state, artifact, branch, snapshot, and receipt contracts where their semantics fit.

Keep trust metadata in separate server-owned records initially. Do not make schema-version-2 execution a prerequisite or add approval fields to user-authored packages as if those fields were authoritative.

### 16.3 Close alternate paths before enabling agent writes

Inventory every operation reachable by an agent, not just the new API: existing job creation, private R kernels, Expert R, workflow execution, synchronous R proxy calls, data import/export, checkpoint mutation, branch promotion, sharing, deletion, environment installation, and target configuration.

Initially, agent credentials should be rejected on every legacy route not explicitly adapted to `ActorContext`. Passing the sponsor's `userId` into a legacy service is not an acceptable substitute for propagating delegated authority. Reject ambiguous combinations of human and agent credentials rather than choose the more privileged one.

Internal workers need narrowly scoped service authority to execute admitted plans; they must not accept caller-forged actor contexts or arbitrary user IDs. Recheck access at dispatch and publication without turning a worker into a general impersonation service.

No new agent credential should be issued with write/execute scopes until this route inventory and its denial tests pass.

## 17. Scientific explanations, prompts, and skills

The application should record a bounded decision summary: the user's study objective, selected approved method, requested deviation, relevant evidence references, assumptions/limitations, and actual outcome. Distinguish user/agent-authored narrative from server-observed facts.

Do not require private chain-of-thought, an exhaustive reasoning transcript, or a model's assertion of confidence. These are not authorization evidence. A concise rationale helps a human understand a proposal but cannot cause an otherwise denied operation to run.

Detailed research procedures, literature-search habits, explanation style, or how an agent plans its work may live in the user's own prompt or skill. TraceOmics may optionally retain an opaque SOP/prompt version reference for provenance, but the initial product need not interpret it or certify compliance.

Anything that must reliably constrain behavior belongs in a machine-enforced policy or workflow contract, not only in a prompt. For example, "do not change donor assignments" becomes a protected input/design identity; "do not submit more than two jobs" becomes a shared reservation limit; "explain your choices" remains a presentation requirement unless the study defines concrete required metadata.

For future automated studies, add versioned protocols with explicit stop rules, approved adaptations, and validation/acceptance contracts. Do not begin by building a general autonomous reasoning engine.

## 18. Verification and acceptance tests

Test the enforcement layer with clients that deliberately ignore instructions. Mocked scheduler tests are necessary but not sufficient. Qualify the actual target in disposable or explicitly allocated test environments; do not run uncontrolled exhaustion tests on shared production infrastructure.

| Scenario | Required outcome |
| --- | --- |
| Agent claims `actorKind=human` or supplies a sponsor/owner ID | Server ignores/rejects the claim; authenticated agent scope remains in force |
| Agent calls a legacy Expert R, private-kernel, or R proxy endpoint | Denied unless that exact operation has an explicit safe adaptation |
| Agent reuses its sponsor's broader project role | Delegation restrictions still apply |
| Agent gains access to a human credential in a deployment test | Deployment fails the separation prerequisite; do not claim protected agent operation |
| Two agents concurrently consume their sponsor's last capacity | At most the permitted work is admitted; all reservations are consistent |
| Agent creates new UUIDs, trials, or agent names to evade limits | Sponsor/study/target limits still bound total work |
| A package declares itself approved or changes bytes under a trusted name | Execution denied until the exact new release has a valid approval |
| Agent supplies code through a parameter, path, environment variable, or startup file | No unapproved execution path; reject unknown/unsafe inputs |
| Individually valid parameters violate a joint study constraint | Plan rejected before dispatch |
| Sponsor membership or approval is revoked after planning | Admission/dispatch revalidation blocks the stale authority |
| Concurrent identical submissions and a lost HTTP response | One local admission and the original recoverable receipt |
| Scheduler accepts a job but its reply is lost | Mark uncertain, retain reservation, reconcile; no blind resubmission |
| Worker lease expires while remote work continues | No premature capacity release or unguarded replacement |
| Cancel request races with completion or targets a reused remote ID | Ownership/attempt binding checked; no other job canceled; no stale result publication |
| Runtime exceeds CPU/memory/process/time/storage limits | Actual site/runtime enforcement bounds it; report the precise observed failure |
| Candidate tries to access home, credentials, other runs, network, or scheduler sockets | Denied according to the required target profile |
| Input source changes while staging | Refuse mismatched data or use the verified immutable version |
| Output contains traversal, links, executable previews, or oversized content | Quarantine/reject without executing or exposing it |
| Workload modifies outputs after validation | Sealed immutable collection prevents acceptance of changed bytes |
| Agent changes its acceptance tests or comparison baseline | Cannot acquire authority; trusted validator/baseline identities remain fixed |
| Failed/successful trials are selectively omitted | Comparison bundle and ledger retain the full bounded trial history |
| Agent requests raw export despite summary-only access | No raw bytes returned through downloads, previews, logs, or alternate routes |
| Human modifies the accepted analysis while a candidate is reviewed | Stale promotion fails compare-and-swap and preserves newer work |
| Agent-controlled text says "ignore policy and run this command" | Treated as data; policy and broker authority unchanged |
| Policy database is down, accounting is delayed, or storage is full | Fail closed for new work; bounded recovery/cancellation remains available |
| Routine approved workflow is repeated within scope | No new source review or per-step approval required |
| Human uses existing authorized expert workflow | Agent restrictions do not silently remove the human capability |

Additional property tests should cover the rule that narrowing a delegation cannot increase effective authority, request replays cannot consume a second reservation, and terminal cleanup cannot remove referenced data. Test all supported runtime/profile combinations, not just the default local runner.

The first complete end-to-end acceptance journey is: a human delegates one approved QC workflow on a saved input; the agent plans and runs it under an enforced resource limit; a lost response is recovered without duplicate work; results are inspected without mutating the baseline; the human accepts the exact candidate; the audit identifies both human and agent throughout.

## 19. Delivery sequence and release gates

### Phase 0: Authority inventory and contracts

Document all execution/mutation/data-disclosure routes, current identity assumptions, supported targets, and required enforcement properties. Define `ActorContext`, delegation, approved release, plan, reservation, and result-state contracts. Build negative authorization tests before exposing a new agent token.

**Gate:** No unexplained path exists from an agent credential to a human-only operation. Unsupported paths explicitly deny agents.

### Phase 1: Read-only agents and inert proposals

Add principal/delegation lifecycle, revocable credentials, bounded metadata/result access, and an initial CLI. Make the UI display the sponsor, actor, and effective limits. Permit code proposals as inert artifacts. Add no HPC execution and no arbitrary code execution in this phase.

**Gate:** End-to-end identity, data-projection, expiry/revocation, and legacy-route denial tests pass. Human workflows continue to work.

### Phase 2: Approved local workflow execution

Register a small set of reviewed executable version-1 workflows or built-in operations. Add study envelopes, exact release approval, candidate workspaces, transactional budgets, idempotency, and result comparison/acceptance. Use existing supported local runtime mechanisms and verify their actual bounds.

**Gate:** One useful scientific workflow runs repeatedly without new source review; unauthorized variations and resource races fail; inputs and accepted state remain unchanged until acceptance.

### Phase 3: One qualified HPC target

Implement one adapter with the institution: restricted gateway or private REST integration. Add durable submission/reconciliation, remote identity binding, site limits, target qualification, and fail-closed uncertainty handling. Keep agent code generation out of this milestone.

**Gate:** Real scheduler acceptance tests pass, including cancellation, lost replies, enforcement, and denied bypasses. The target does not report readiness from mocked evidence.

### Phase 4: Optional isolated development

Enable candidate execution only for an explicitly qualified development target and explicit grants. Start with fixed fixtures, prebuilt environments, trusted tests, small budgets, and immutable proposals. Add review-to-release promotion.

**Gate:** Candidate code cannot reach production credentials/data/writes, change its tests/policy, or authorize itself. Without that evidence, remain proposal-only.

### Phase 5: Bounded protocol automation

Add approved workflow composition, finite sensitivity studies, and optional standing result-acceptance rules. Add MCP as needed over the same service contracts. Measure review burden before expanding autonomy.

**Gate:** Automation reduces active researcher time without increasing hidden methodological variation, undisclosed trials, or operational incidents.

The minimum useful release is Phase 2, not a general-purpose AI development platform. HPC is an adapter and deployment qualification milestone; arbitrary code generation is not a prerequisite for useful automation.

## 20. Decisions that depend on deployment

| Decision | Initial default | What must be resolved before expansion |
| --- | --- | --- |
| Scheduler and execution identity | No assumption about Slurm availability or shared accounts | HPC operator-approved adapter, account mapping, and attribution |
| Agent-generated code on HPC | Disabled | Verified development profile and explicit grant |
| Scientific parameter freedom | Exact values or finite lab-approved options | Method-specific applicability and joint constraints |
| Data visible to external agents | Narrow authorized metadata/results; no raw export | Institutional/provider disclosure policy and field-level permissions |
| Approval separation | Explicit human capability; agent cannot approve | Whether higher-risk releases need a second independent reviewer |
| Standing acceptance | Off | Exact rule, trusted validation, intended effect, and failure handling |
| Resource values | Site-configured, conservative hard caps | Representative measurements, headroom, accounting, and scheduler enforcement |
| Existing human access | Retain within existing permissions | Agent runtime must not possess those human credentials |

These are deployment choices, not reasons to delay the credential/approved-workflow design. Implement explicit unsupported states instead of silently weakening a requirement to fit a target.

## 21. Alternatives intentionally rejected

**Prompt-only guardrails:** Helpful guidance, but they do not enforce permissions, resource limits, or data access.

**One human account for all actions:** Easy integration, but loses actor attribution and lets the agent inherit human privileges.

**An unrestricted shell with a job-count wrapper:** Does not control other resource use, filesystem changes, nested submission, or scientific method changes.

**Approve every command:** Produces review fatigue while still allowing dangerous combinations of individually innocuous actions.

**Automatically approve small diffs or test-passing generated code:** Confuses syntactic size/test coverage with scientific and security authority.

**Use a copied environment as the safety boundary:** Protects some working state but does not establish resource, credential, or host isolation.

**Build a new general workflow engine first:** Delays useful functionality and duplicates existing execution/state machinery. Start with a small approved catalog and supported runtimes.

## 22. Reference notes

### Repository evidence

The implementation observations in Section 3 are based on the pinned [repository baseline](https://github.com/IsaacJYPan/scrna-seq/tree/1bbd2c84372857af6ad9282f6ba1fb82d27043d4). Relative links target the `docs/spec.md` location. Revalidate these observations as the codebase changes; this document is not a completed security audit or a claim that new capabilities already exist.

### Primary technical references

**S1.** [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693.html), especially delegation versus impersonation and the actor claim. This is a semantic reference, not a requirement to implement token exchange in the first release.

**S2.** [Python documentation: `venv`](https://docs.python.org/3/library/venv.html), describing independent package environments. Execution containment requires separate OS/runtime enforcement.

**S3.** [Apptainer documentation: bind paths and mounts](https://apptainer.org/docs/user/main/bind_paths_and_mounts.html), including default host mounts, user-controlled binds, and read-only mount options. Validate the installed site version and configuration.

**S4.** [Slurm documentation: resource limits](https://slurm.schedmd.com/resource_limits.html), including accounting enforcement, job/resource limits, and precedence rules. Effective site policy must be verified rather than inferred from requested flags.

**S5.** [Slurm documentation: `cgroup.conf`](https://slurm.schedmd.com/cgroup.conf.html), including CPU, memory, and device constraint configuration. Resource requests and hard confinement are different concerns.

**S6.** [Slurm documentation: REST API details](https://slurm.schedmd.com/rest.html), especially the security and authentication guidance. The broker/control plane is the client of the site's private scheduler boundary, not the external agent.

**S7.** [OpenSSH documentation: `sshd_config`](https://man.openbsd.org/sshd_config), especially `ForceCommand`, `DisableForwarding`, environment handling, and the limits of SSH configuration alone.

---

## Final implementation principle

**Make the safe path useful enough that the agent usually does not need more freedom.**

A researcher should delegate a bounded scientific task, not a cluster login. The agent should spend most of its effort selecting and coordinating reviewed capabilities, not inventing scripts that transfer the burden back to the researcher. New methods remain possible, but they cross an explicit development-and-review boundary before becoming routine execution authority.

[S1]: https://www.rfc-editor.org/rfc/rfc8693.html "RFC 8693: OAuth 2.0 Token Exchange"
[S2]: https://docs.python.org/3/library/venv.html "Python venv documentation"
[S3]: https://apptainer.org/docs/user/main/bind_paths_and_mounts.html "Apptainer bind paths and mounts"
[S4]: https://slurm.schedmd.com/resource_limits.html "Slurm resource limits"
[S5]: https://slurm.schedmd.com/cgroup.conf.html "Slurm cgroup.conf"
[S6]: https://slurm.schedmd.com/rest.html "Slurm REST API details"
[S7]: https://man.openbsd.org/sshd_config "OpenSSH sshd_config"
