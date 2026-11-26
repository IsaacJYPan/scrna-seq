-- Publish invalidations on commit, including worker writes from other processes.
CREATE OR REPLACE FUNCTION notify_agent_notebook_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  notebook_project text := NEW.project_id;
  sandbox_owner bigint;
BEGIN
  IF TG_TABLE_NAME = 'jobs' THEN
    SELECT project_id INTO notebook_project FROM agent_runs WHERE job_id = NEW.id;
    IF NOT FOUND THEN
      SELECT sr.project_id, sb.created_by_user_id INTO notebook_project, sandbox_owner
        FROM agent_sandbox_runs sr JOIN agent_sandboxes sb ON sb.id = sr.sandbox_id
        WHERE sr.job_id = NEW.id;
      IF NOT FOUND THEN RETURN NEW; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'agent_sandbox_runs' AND TG_OP = 'UPDATE' THEN
    SELECT created_by_user_id INTO sandbox_owner FROM agent_sandboxes WHERE id = NEW.sandbox_id;
  END IF;

  -- A new sandbox run changes the hidden-run count even for viewers who
  -- cannot inspect it. Its subsequent changes are visible only to reviewers.
  PERFORM pg_notify('traceomics_agent_notebook',
    json_build_object('projectId', notebook_project, 'sandboxOwner', sandbox_owner::text)::text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_notebook_note_added
  AFTER INSERT ON agent_notebook_notes
  FOR EACH ROW EXECUTE FUNCTION notify_agent_notebook_change();
CREATE TRIGGER agent_notebook_run_added
  AFTER INSERT ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION notify_agent_notebook_change();
CREATE TRIGGER agent_notebook_run_cancel_requested
  AFTER UPDATE OF cancel_requested_at ON agent_runs
  FOR EACH ROW WHEN (OLD.cancel_requested_at IS DISTINCT FROM NEW.cancel_requested_at)
  EXECUTE FUNCTION notify_agent_notebook_change();
CREATE TRIGGER agent_notebook_sandbox_run_changed
  AFTER INSERT OR UPDATE OF cancel_requested_at, review_state ON agent_sandbox_runs
  FOR EACH ROW EXECUTE FUNCTION notify_agent_notebook_change();
CREATE TRIGGER agent_notebook_result_accepted
  AFTER INSERT ON result_acceptances
  FOR EACH ROW EXECUTE FUNCTION notify_agent_notebook_change();
CREATE TRIGGER agent_notebook_job_changed
  AFTER UPDATE OF status, result_analysis_object_id ON jobs
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status
    OR OLD.result_analysis_object_id IS DISTINCT FROM NEW.result_analysis_object_id)
  EXECUTE FUNCTION notify_agent_notebook_change();
