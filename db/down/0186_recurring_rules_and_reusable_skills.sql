BEGIN;
LOCK TABLE control_recurring_proposals, control_recurring_rules, control_task_skill_bindings,
  control_skill_versions, control_skills IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_recurring_proposals) OR EXISTS (SELECT 1 FROM control_recurring_rules)
    OR EXISTS (SELECT 1 FROM control_task_skill_bindings) OR EXISTS (SELECT 1 FROM control_skill_versions)
    OR EXISTS (SELECT 1 FROM control_skills) THEN
    RAISE EXCEPTION '0186 down migration refused: recurring work or reusable skill records remain';
  END IF;
END $$;
DROP TRIGGER IF EXISTS control_recurring_proposals_delete_guard ON control_recurring_proposals;
DROP TRIGGER IF EXISTS control_recurring_proposals_truncate_guard ON control_recurring_proposals;
DROP TRIGGER IF EXISTS control_recurring_proposals_update_guard ON control_recurring_proposals;
DROP TRIGGER IF EXISTS control_recurring_proposals_batch_guard ON control_recurring_proposals;
DROP FUNCTION IF EXISTS guard_recurring_proposal_update();
DROP FUNCTION IF EXISTS guard_recurring_proposal_batch();
DROP TABLE IF EXISTS control_recurring_proposals;
DROP TABLE IF EXISTS control_recurring_rules;
DROP TRIGGER IF EXISTS control_task_skill_bindings_truncate_guard ON control_task_skill_bindings;
DROP TRIGGER IF EXISTS control_task_skill_bindings_append_only ON control_task_skill_bindings;
DROP TABLE IF EXISTS control_task_skill_bindings;
DROP TRIGGER IF EXISTS control_skills_update_guard ON control_skills;
DROP FUNCTION IF EXISTS guard_control_skill_head_update();
DROP TRIGGER IF EXISTS control_skill_versions_truncate_guard ON control_skill_versions;
DROP TRIGGER IF EXISTS control_skill_versions_append_only ON control_skill_versions;
DROP TABLE IF EXISTS control_skill_versions;
DROP TABLE IF EXISTS control_skills;
COMMIT;
