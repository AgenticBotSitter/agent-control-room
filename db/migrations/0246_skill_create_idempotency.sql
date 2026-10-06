-- 0246: reusable skill create becomes idempotent per authenticated action.
--
-- THE BUG THIS FIXES. `ReusableSkillServiceV1.create` minted a fresh
-- `skill:<uuid>` on every call, and the browser's create request carried no
-- action key, so nothing bound "this is the same thing I asked for" to
-- anything. If the create transaction committed and its reply was lost - a
-- dropped connection, a timeout, a navigation that raced the response - the
-- owner's only recovery was to press Save again, and that created a SECOND
-- skill with the same name and instructions. Measured on real PostgreSQL 17 as
-- the production web login: one dropped reply plus 50 identical replays left
-- 52 same-name skills. Nothing in the product claimed a save had failed; the
-- owner was told each save succeeded.
--
-- WHY A NEW TABLE RATHER THAN control_idempotency. That ledger exists and the
-- private web login already holds SELECT plus UPDATE(status, result,
-- completed_at) on it, so reusing it would have needed no migration at all.
-- It is the wrong table: 0093 hangs `guard_work_intake_idempotency_write` off
-- control_idempotency BEFORE INSERT OR UPDATE, and that guard RAISES unless the
-- row is a work-intake proposal whose batch row matches. A skill create would
-- be rejected by a guard written for a different feature - and the only way to
-- write a row the guard admits is to be the work-intake login. Widening that
-- guard to mean "or a skill" would turn one feature's invariant into a
-- disjunctive over both, so the next change to either would have to reason
-- about the other. A dedicated table keeps the skill invariant local.
--
-- The key is scoped to (tenant, project, identity, action key) rather than
-- tenant-wide: the same browser action key reused by a different project or a
-- different owner is a different action and must not be answered with someone
-- else's skill.
CREATE TABLE control_skill_create_actions (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  identity_id text NOT NULL,
  action_key text NOT NULL CHECK (action_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  skill_id text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, project_id, identity_id, action_key),
  FOREIGN KEY (tenant_id, identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, skill_id) REFERENCES control_skills(tenant_id, project_id, skill_id) ON DELETE RESTRICT
);

-- Append-only, like every other command receipt in this schema: the record of
-- "this action produced this skill" is a fact, and a rewritten one would let a
-- replay answer with a skill the action never created.
CREATE TRIGGER control_skill_create_actions_append_only BEFORE UPDATE OR DELETE ON control_skill_create_actions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_skill_create_actions_truncate_guard BEFORE TRUNCATE ON control_skill_create_actions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- The lookup the replay path performs on every retry.
CREATE INDEX control_skill_create_actions_by_skill ON control_skill_create_actions(tenant_id, project_id, skill_id);

-- Least privilege: the private web login inserts and reads its own action
-- receipts. It is deliberately NOT granted UPDATE or DELETE, which the
-- append-only trigger would refuse anyway.
--
-- The grant is inside a role-existence check, as every other migration's is: a
-- migration has to apply to a database whose private web login was never
-- installed, and an unguarded GRANT would abort the whole upgrade there rather
-- than simply not granting. Found while running the lane: 7 tests failed with
-- `role "control_room_private_web" does not exist` before this was guarded.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT SELECT, INSERT ON control_skill_create_actions TO control_room_private_web';
  END IF;
END $$;
