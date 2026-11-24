-- Project figure organisation: a named collection (e.g. "Figure 2"), free-form
-- tags, a caption/notes field and an edit timestamp. Metadata only.
ALTER TABLE figure_collection ADD COLUMN IF NOT EXISTS collection_name TEXT NOT NULL DEFAULT '';
ALTER TABLE figure_collection ADD COLUMN IF NOT EXISTS tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE figure_collection ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
ALTER TABLE figure_collection ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Named folders on the cluster a person lets the agent read and stage from
-- (backend/agentSandbox/remoteFiles.js). Fixed at creation like the inputs.
ALTER TABLE agent_sandboxes ADD COLUMN IF NOT EXISTS remote_roots_json JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Why the agent wrote its own R instead of using verified code. Required for
-- new runs (sandboxes.submitRun); NULL only on runs recorded before it existed.
ALTER TABLE agent_sandbox_runs ADD COLUMN IF NOT EXISTS agent_reason TEXT
  CHECK (agent_reason IS NULL OR char_length(agent_reason) BETWEEN 1 AND 1000);
ALTER TABLE agent_sandbox_runs ADD COLUMN IF NOT EXISTS remote_inputs_json JSONB NOT NULL DEFAULT '[]'::jsonb;

-- What was actually staged from a remote folder into a cluster sandbox run:
-- the file's root, relative path, size and the SHA-256 of the staged copy.
-- Append-only evidence written by the worker before the run is submitted.
CREATE TABLE IF NOT EXISTS agent_sandbox_remote_inputs (
  run_id           TEXT NOT NULL REFERENCES agent_sandbox_runs(id),
  position         INTEGER NOT NULL CHECK (position BETWEEN 0 AND 4),
  root_name        TEXT NOT NULL CHECK (root_name ~ '^[a-z][a-z0-9_-]{0,31}$'),
  relative_path    TEXT NOT NULL CHECK (char_length(relative_path) BETWEEN 1 AND 1024),
  size_bytes       BIGINT NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256  TEXT NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  staged_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, position)
);
CREATE OR REPLACE FUNCTION protect_agent_sandbox_remote_input()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.demo_cleanup', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'staged remote inputs are retained evidence' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_agent_sandbox_remote_input_protect ON agent_sandbox_remote_inputs;
CREATE TRIGGER trg_agent_sandbox_remote_input_protect
  BEFORE UPDATE OR DELETE ON agent_sandbox_remote_inputs
  FOR EACH ROW EXECUTE FUNCTION protect_agent_sandbox_remote_input();

-- ── Agent notebook (docs/agent-automation.md, "Agent notebook") ─────────────
-- Agent work is filed under the analysis tab it serves so it reads top to
-- bottom like a notebook. An agent's own script names its tab when it is
-- submitted (shared/agentNotebookTabs.mjs); NULL only on older runs.
ALTER TABLE agent_sandbox_runs ADD COLUMN IF NOT EXISTS analysis_tab TEXT
  CHECK (analysis_tab IS NULL OR analysis_tab IN
    ('qc', 'normalize', 'pca', 'integrate', 'cluster', 'umap', 'deg', 'enrichment', 'cellchat', 'explore'));

-- Short Markdown notes an agent places between its cells, like text cells in
-- a notebook. Append-only: an agent adds notes, never edits or removes them.
CREATE TABLE IF NOT EXISTS agent_notebook_notes (
  id                    TEXT PRIMARY KEY CHECK (id ~ '^nbn_[0-9a-f]{24}$'),
  project_id            TEXT NOT NULL REFERENCES projects(id),
  delegation_id         TEXT NOT NULL REFERENCES agent_delegations(id),
  agent_principal_id    TEXT NOT NULL REFERENCES agent_principals(id),
  sponsor_user_id       BIGINT NOT NULL REFERENCES users(id),
  request_id            TEXT NOT NULL CHECK (request_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  request_sha256        TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  analysis_tab          TEXT NOT NULL CHECK (analysis_tab IN
    ('qc', 'normalize', 'pca', 'integrate', 'cluster', 'umap', 'deg', 'enrichment', 'cellchat', 'explore')),
  body_markdown         TEXT NOT NULL CHECK (char_length(body_markdown) BETWEEN 1 AND 8000),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (delegation_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_notebook_notes_project ON agent_notebook_notes(project_id, created_at);
DROP TRIGGER IF EXISTS trg_agent_notebook_notes_immutable ON agent_notebook_notes;
CREATE TRIGGER trg_agent_notebook_notes_immutable
  BEFORE UPDATE OR DELETE ON agent_notebook_notes
  FOR EACH ROW EXECUTE FUNCTION reject_agent_report_mutation();
