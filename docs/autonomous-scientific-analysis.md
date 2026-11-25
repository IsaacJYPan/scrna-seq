# Autonomous scientific analysis in delegated studies

This proposal gives a delegated researcher enough guidance, evidence, and
authority to carry a study from data inspection through a reviewable report.
It builds on [staged execution and inspection](workflow-trust-and-inspection.md)
and the [agent notebook and review process](agent-automation.md#agent-notebook).

## Bundle a default analysis-review skill

Supply a versioned analysis-review skill with the study context by default.
Pin the skill version alongside the study objective so a reviewer can see
which guidance was available. The sponsor's question and approved study
design determine which checks and analyses are relevant.

At the start, inspect the study design and identify the independent biological
units, the requested results, and the comparisons the design can support.
At a consequential decision, record the proposed choice, a plausible
alternative explanation, and what result would change the choice. Inspect the
relevant artifact, run a targeted check when it could change the conclusion,
and record the artifact, observation, and resulting action in the notebook.
If the available evidence leaves an ambiguity unresolved, carry that limitation
into the report.

> I’m deciding whether to carry this finding forward. A plausible alternative
> is [explanation]. If the check shows [observation], I’ll change [decision].
> Artifact [ID] showed [result], so I [action].

Use this pattern for decisions that affect the claim, such as keeping a QC
threshold, refining a population, or interpreting a result dominated by one
specimen. Keep routine run details in the existing run record.

## Make intermediate evidence available for decisions

Extend `inspect_run` and `preview_artifact` across approved workflows with
consistent summaries and links to the underlying tables. Use existing run and
artifact IDs and respect the delegation's disclosure profile.

| Decision | Evidence to expose |
| --- | --- |
| Apply a QC filter | Feature match counts for each metric, per-specimen distributions, and before-and-after retention. Give unavailable metrics an explicit status distinct from measured values. |
| Choose graph settings or refine a population | Available PCA variance and its denominator, marker evidence, population membership, and counts by specimen. Show how coverage changes when cells are subsampled or a lineage is subsetted. |
| Interpret a condition contrast | The numerator, denominator, biological unit, actual eligible and excluded specimens by arm, cell-count floor, design rank, residual degrees of freedom, and estimability of the requested contrast. |
| Interpret a derived result | The source contrast and population, feature mapping and tested background where applicable, and the scope of any truncated output. For candidate signaling, expose each condition's evaluated sender, receiver, ligand, and receptor rows and their coverage. |

For example, if the mitochondrial feature pattern matches zero genes, show
that the metric is unavailable alongside the matching rule. This gives the
agent a concrete reason to check identifiers before using the metric to
filter cells or describe sample quality.

## Allow provisional follow-on runs inside the delegation

Current [follow-on studies](agent-automation.md#approved-workflow-execution-phase-2)
can use a human-accepted study result or an eligible saved analysis. Add an
option for the sponsor to authorize provisional follow-ons within one bounded
study. The sponsor specifies the allowed data, workflow releases, protected
design choices, and compute limits. The agent can inspect a candidate
clustering, derive a lineage subset, recluster it, and run an approved
contrast on that branch.

Pin the exact parent run and checkpoint for each follow-on and record its
release, parameters, and consumed budget. Require a completed, eligible parent
checkpoint from the same study and delegation, validate the parent against
the downstream release's input contract, and recheck authority and budget at
admission and dispatch. Apply existing expiry, revocation, cancellation, and
quarantine rules to every branch. Existing sandbox approvals apply to agent
code. Human acceptance remains the operation that promotes the final result.

## Verify outputs before closeout

Track each requested result as pending, verified, or blocked. For a verified
result, link the exact output inspected and record its relevant coverage.
For a blocked result, record the missing evidence, data, or authority and
what can still be concluded. A successful run receipt establishes execution
status. Artifact inspection establishes whether the expected evidence was
produced and is usable for the claim. Keep this record in the notebook and
surface it with the report for sponsor review.

## Rollout and evaluation

Start with the default skill and the inspection summaries for QC, population
coverage, and donor eligibility. In fresh, paper-blind runs, vary only whether
the skill is supplied. Hold the masked inputs, tools, permissions, and task
scope fixed across arms. Score whether agents inspected evidence before
consequential choices, ran checks that could distinguish plausible explanations,
adjusted their claims when warranted, and verified requested outputs without
reminders.
Track agreement with published findings separately.

Add provisional follow-ons as a separate execution change. Verify that an
authorized branch can reach a reviewable report from an immutable candidate
and that revoked, out-of-scope, or incompatible branches fail at the existing
authority and input boundaries.
