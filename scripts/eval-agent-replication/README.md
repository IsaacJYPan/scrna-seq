# Blind replication of a published single-cell study

These files run an AI agent on a published dataset as if nobody had analyzed it
before, then grade what it found against the paper. The method and results
are in [docs/agent-evaluation.md](../../docs/agent-evaluation.md).

- `brief-baseline.md`: the agent's instructions as TraceOmics gave them before
  the analysis ledger. They hold the researcher's description of the study and
  the app's agent guidance (tabs, scripts with reasons, notebook notes, a
  section-by-section report).
- `brief-ledger.md`: the same brief, plus the analysis ledger protocol and the
  standard checklist from `shared/analysisLedger.mjs`. The agent records entries
  with `scripts/analysis-ledger-local.mjs`, which applies the server's
  validation, cited-value check and audit to a local `ledger.jsonl`. The brief
  records the checklist as it was for the evaluation; the current list is
  `ANALYSIS_CHECKLIST` (the malignancy item has since become the general
  `explore.orthogonal-support`).

- `make-brief.mjs` builds a brief from a study description in `studies/` and
  the current `LEDGER_PROTOCOL` and `ANALYSIS_CHECKLIST`. It writes a ledger
  brief, or with `--baseline` one without the ledger. A study file holds only
  what the researcher knows before analyzing: the design, the samples, the
  question and the data format.
- The local ledger tool's `run` command stands in for a sandbox run. It runs a
  script, records which outputs it wrote in `runs.jsonl`, and refuses the next
  script while more than one finished run is uncited (`LEDGER_BEHIND`), as the
  server does.

To run one:

1. Put the raw matrices in `<eval>/data/sample*/`.
2. Make `<eval>/run<X>/` with `scripts/ logs/ outputs/ report/`, and write
   `node make-brief.mjs studies/<study>.md > <eval>/run<X>/BRIEF.md`.
3. Start the agent there. Tell it to read `BRIEF.md`, not to use the web, and
   not to read anything outside its run folder and `data/`.

Keep the paper, the authors' code and the answer key outside the agent's
reach, and outside this repository.

After a run, `node scripts/analysis-ledger-local.mjs audit --report
report/report.md` (run in the run folder) reprints the audit. The run's
`ledger.jsonl` shows when each entry was written.
