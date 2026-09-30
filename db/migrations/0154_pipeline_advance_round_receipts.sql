-- S7b: one advance receipt per fix round, and the guard on the loop-limit
-- Needs Attention item.
--
-- 0109 made `pipeline_advance_receipts` unique per (run, stage), which was
-- correct while a stage could only ever be entered once. Enforcing the loop
-- ceilings means a stage is re-entered with a new planned job, and that round
-- needs its own durable receipt: the stage's first receipt is history, and
-- reusing its key would make a legitimate fix round unrecordable.
--
-- The key becomes (run, stage, round). The existing one-receipt-per-stage rows
-- are round 0, and the table's append-only triggers, foreign keys and every
-- other invariant are untouched.
--
-- When a stage or a run reaches its loop ceiling, unattended advance stops for
-- that run and the owner is told once. The coordinator login already holds
-- INSERT on control_action_inbox (0102) for the existing owner-attention paths,
-- so the guard below confines the new pipeline-loop shape to exactly what the
-- advance service builds and refuses every other use of that id prefix, for any
-- role. Every pre-existing attention path is untouched.
--
-- No new table, grant, scheduler, provider invocation, merge or external
-- effect is added.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE pipeline_advance_receipts ADD COLUMN loop_index bigint NOT NULL DEFAULT 0
  CHECK (loop_index >= 0);
-- One durable receipt per fix round. A replayed advance still lands on the same
-- key, because the round is derived from the immutable job chain.
ALTER TABLE pipeline_advance_receipts DROP CONSTRAINT pipeline_advance_receipts_tenant_id_pipeline_run_id_stage_o_key;
ALTER TABLE pipeline_advance_receipts ADD CONSTRAINT pipeline_advance_receipts_round_key
  UNIQUE (tenant_id, pipeline_run_id, stage_ordinal, loop_index);

CREATE FUNCTION guard_pipeline_loop_attention_item() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id NOT LIKE 'attention:pipeline-loop:%' THEN
    RETURN NEW;  -- an existing writer's item keeps 0102's and the store's own rules
  END IF;
  IF NEW.kind IS DISTINCT FROM 'question' OR NEW.state IS DISTINCT FROM 'open'
    OR NEW.delivery_state IS DISTINCT FROM 'not_requested' OR NEW.expires_at IS NOT NULL
    OR NEW.work_item_id IS NULL OR NEW.project_id IS NULL
    OR NEW.payload->>'schema' IS DISTINCT FROM 'control-room.pipeline-loop-attention/v1'
    OR NEW.payload->>'id' IS DISTINCT FROM NEW.id
    OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id
    OR NEW.payload->>'projectId' IS DISTINCT FROM NEW.project_id
    OR NEW.payload->>'workItemId' IS DISTINCT FROM NEW.work_item_id
    OR NEW.payload->>'kind' IS DISTINCT FROM NEW.kind
    OR NEW.payload->>'state' IS DISTINCT FROM NEW.state
    OR NEW.payload->>'deliveryState' IS DISTINCT FROM NEW.delivery_state
    OR NEW.payload->>'reasonCode' IS NULL
    OR NEW.payload->>'reasonCode' NOT IN ('pipeline_stage_loop_limit_reached',
      'pipeline_run_loop_limit_reached')
    OR NEW.payload->>'requestedAction' IS NULL
    OR jsonb_typeof(NEW.payload->'blockedWorkItemIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.payload->'legalResponses') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.payload->'evidence') IS DISTINCT FROM 'array'
    OR NOT EXISTS (SELECT 1 FROM public.pipeline_stage_runs s
      WHERE s.tenant_id=NEW.tenant_id AND s.project_id=NEW.project_id
        AND s.pipeline_run_id=NEW.payload->>'pipelineRunId' AND s.stage_ordinal=(NEW.payload->>'stageOrdinal')::bigint)
    OR NOT EXISTS (SELECT 1 FROM public.pipeline_runs r
      WHERE r.tenant_id=NEW.tenant_id AND r.project_id=NEW.project_id AND r.id=NEW.payload->>'pipelineRunId') THEN
    RAISE EXCEPTION 'pipeline loop attention item rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_pipeline_loop_attention_item() FROM PUBLIC;
CREATE TRIGGER control_action_inbox_pipeline_loop_guard
  BEFORE INSERT ON public.control_action_inbox
  FOR EACH ROW EXECUTE FUNCTION public.guard_pipeline_loop_attention_item();

-- The owner resolves it exactly as every other attention item: the payload's
-- state moves to resolved and nothing else changes.
--
-- This guard is UPDATE ONLY. It used to be attached to UPDATE OR DELETE, but a
-- BEFORE DELETE row trigger returns NEW, which is NULL on a delete, so every
-- DELETE on control_action_inbox -- including admin cleanup and restore tooling
-- on an ordinary, unrelated inbox row -- silently affected zero rows without
-- raising anything. The delete path is its own guard below, which passes a
-- non-pipeline row through and refuses to delete a pipeline-loop item that is
-- still open, so an owner item can never be removed while it is unresolved.
CREATE FUNCTION guard_pipeline_loop_attention_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.id NOT LIKE 'attention:pipeline-loop:%' THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
    OR NEW.kind<>OLD.kind OR OLD.state<>'open' OR NEW.state<>'resolved'
    OR NEW.delivery_state<>OLD.delivery_state OR NEW.created_at<>OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.payload<>pg_catalog.jsonb_set(OLD.payload,'{state}','"resolved"'::jsonb) THEN
    RAISE EXCEPTION 'pipeline loop attention update rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_pipeline_loop_attention_update() FROM PUBLIC;
CREATE TRIGGER control_action_inbox_pipeline_loop_update_guard
  BEFORE UPDATE ON public.control_action_inbox
  FOR EACH ROW EXECUTE FUNCTION public.guard_pipeline_loop_attention_update();

CREATE FUNCTION guard_pipeline_loop_attention_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.id NOT LIKE 'attention:pipeline-loop:%' THEN
    RETURN OLD;  -- an existing writer's row keeps the store's own rules
  END IF;
  IF OLD.state<>'resolved' THEN
    RAISE EXCEPTION 'pipeline loop attention delete rejected';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.guard_pipeline_loop_attention_delete() FROM PUBLIC;
CREATE TRIGGER control_action_inbox_pipeline_loop_delete_guard
  BEFORE DELETE ON public.control_action_inbox
  FOR EACH ROW EXECUTE FUNCTION public.guard_pipeline_loop_attention_delete();
