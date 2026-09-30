BEGIN;
-- 0154 alone: the per-round receipt key and the guards on the loop-limit
-- Needs Attention item. It relaxes one unique constraint, adds one column and
-- creates three triggers with their functions, so the down path reverses all of
-- them and nothing else. It holds no table and grants nothing, so the only
-- installed state it could silently discard is a fix-round receipt, and it
-- refuses there.
LOCK TABLE pipeline_advance_receipts IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pipeline_advance_receipts WHERE loop_index > 0) THEN
    RAISE EXCEPTION 'pipeline round-receipt down migration refused: fix-round receipts exist';
  END IF;
END $$;
DROP TRIGGER control_action_inbox_pipeline_loop_delete_guard ON control_action_inbox;
DROP TRIGGER control_action_inbox_pipeline_loop_update_guard ON control_action_inbox;
DROP TRIGGER control_action_inbox_pipeline_loop_guard ON control_action_inbox;
DROP FUNCTION guard_pipeline_loop_attention_delete();
DROP FUNCTION guard_pipeline_loop_attention_update();
DROP FUNCTION guard_pipeline_loop_attention_item();
ALTER TABLE pipeline_advance_receipts DROP CONSTRAINT pipeline_advance_receipts_round_key;
ALTER TABLE pipeline_advance_receipts ADD CONSTRAINT pipeline_advance_receipts_tenant_id_pipeline_run_id_stage_o_key
  UNIQUE (tenant_id, pipeline_run_id, stage_ordinal);
ALTER TABLE pipeline_advance_receipts DROP COLUMN loop_index;
COMMIT;
