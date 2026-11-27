-- ── Analysis ledger (docs/agent-automation.md, "Analysis ledger") ───────────
-- Structured records of an agent's reasoning: decisions, cluster labels,
-- findings, issues and checklist answers, each citing the run outputs that
-- support it (shared/analysisLedger.mjs). The audit people read before a
-- report is computed from these rows. Append-only: a label or decision is
-- revised by a newer entry, and an issue is closed by a later entry that
-- refers to it.
CREATE TABLE IF NOT EXISTS agent_ledger_entries (
  id                    TEXT PRIMARY KEY CHECK (id ~ '^led_[0-9a-f]{24}$'),
  project_id            TEXT NOT NULL REFERENCES projects(id),
  delegation_id         TEXT NOT NULL REFERENCES agent_delegations(id),
  agent_principal_id    TEXT NOT NULL REFERENCES agent_principals(id),
  sponsor_user_id       BIGINT NOT NULL REFERENCES users(id),
  request_id            TEXT NOT NULL CHECK (request_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  request_sha256        TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  entry_kind            TEXT NOT NULL CHECK (entry_kind IN ('decision', 'annotation', 'finding', 'issue', 'check')),
  analysis_tab          TEXT NOT NULL CHECK (analysis_tab IN
    ('qc', 'normalize', 'pca', 'integrate', 'cluster', 'umap', 'deg', 'enrichment', 'cellchat', 'explore')),
  refers_to             TEXT REFERENCES agent_ledger_entries(id),
  entry_json            JSONB NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (delegation_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_ledger_entries_project ON agent_ledger_entries(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_ledger_entries_agent ON agent_ledger_entries(agent_principal_id, project_id, created_at);
DROP TRIGGER IF EXISTS trg_agent_ledger_entries_immutable ON agent_ledger_entries;
CREATE TRIGGER trg_agent_ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON agent_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_agent_report_mutation();
