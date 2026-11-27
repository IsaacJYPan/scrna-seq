-- Analysis ledger: allow interpretation entries (what a run showed, what it
-- means, the alternatives and the next step) and prediction entries (what the
-- agent expects before a run, tested afterwards by an interpretation).
ALTER TABLE agent_ledger_entries DROP CONSTRAINT IF EXISTS agent_ledger_entries_entry_kind_check;
ALTER TABLE agent_ledger_entries ADD CONSTRAINT agent_ledger_entries_entry_kind_check
  CHECK (entry_kind IN ('decision', 'annotation', 'finding', 'issue', 'check', 'interpretation', 'prediction'));
