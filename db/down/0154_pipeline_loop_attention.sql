BEGIN;
-- 0154 alone: the two guards on the loop-limit Needs Attention item. It holds
-- no table and grants nothing, so the only thing a down must remove is its
-- own two triggers and their function.
DROP TRIGGER control_action_inbox_pipeline_loop_update_guard ON control_action_inbox;
DROP TRIGGER control_action_inbox_pipeline_loop_guard ON control_action_inbox;
DROP FUNCTION guard_pipeline_loop_attention_update();
DROP FUNCTION guard_pipeline_loop_attention_item();
COMMIT;
