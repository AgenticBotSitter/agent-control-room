-- MIG-A (plan v4.3 §2.1): the per-project orchestrator selection.
--
-- Plan §2.1 requires a tri-state so that existing settings rows do not accidentally
-- enable or disable orchestration:
--
--   planner_mode 'inherit' -- this project has no opinion; the installation default
--                             applies. This is the value an untouched row carries.
--   planner_mode 'none'    -- a deliberate owner choice: no orchestrator, the owner
--                             writes the plan by hand.
--   planner_mode 'selected'-- an orchestrator worker is named, with an optional model
--                             and effort.
--
-- The selected columns are constrained AS ONE COHERENT SELECTION: 'selected' requires
-- a worker, and a worker may only be named in 'selected' mode, with a model and
-- effort that the database can at least name-check. The database does NOT know
-- which workers an installation has -- that is the protected queue catalog the
-- application resolves on every run -- so a stored selection is a request, never
-- execution authority. owner_read_planner_selection_v1() below therefore returns
-- the request only, never a resolved worker, and the application re-resolves it
-- against the catalog at run time and refuses a selection the catalog no longer
-- holds.
--
-- 'default' is deliberately NOT accepted as an effort: 0135's default_effort
-- accepts it because a task model default may be the harness's own default, but a
-- planner selection is resolved by resolveWorkBatchQueueWorkerV1 against a model
-- policy, and a stored 'default' there would name no concrete model. The owner
-- leaves the effort NULL to mean "the catalog's default".

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE control_project_settings
  ADD COLUMN planner_mode text NOT NULL DEFAULT 'inherit',
  ADD COLUMN planner_worker_id text,
  ADD COLUMN planner_worker_kind text,
  ADD COLUMN planner_model text,
  ADD COLUMN planner_effort text,
  ADD CONSTRAINT control_project_settings_planner_mode_check
    CHECK (planner_mode IN ('inherit','none','selected')),
  ADD CONSTRAINT control_project_settings_planner_worker_id_check
    CHECK (planner_worker_id IS NULL OR planner_worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  ADD CONSTRAINT control_project_settings_planner_worker_kind_check
    CHECK (planner_worker_kind IS NULL OR planner_worker_kind IN ('codex','claude-code','hermes')),
  ADD CONSTRAINT control_project_settings_planner_model_check
    CHECK (planner_model IS NULL OR planner_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$'),
  ADD CONSTRAINT control_project_settings_planner_effort_check
    CHECK (planner_effort IS NULL OR planner_effort IN ('low','medium','high','xhigh','max')),
  -- One coherent selection, or no selection at all.
  ADD CONSTRAINT control_project_settings_planner_selection_coherent CHECK (
    (planner_mode='selected'
      AND planner_worker_id IS NOT NULL AND planner_worker_kind IS NOT NULL)
    OR (planner_mode<>'selected'
      AND planner_worker_id IS NULL AND planner_worker_kind IS NULL
      AND planner_model IS NULL AND planner_effort IS NULL)
  );

-- The read adapter. A plain VIEW, not a SECURITY DEFINER function: the coordinator
-- login already holds SELECT on control_project_settings (0135's scheduling read),
-- so no privilege needs widening, and the private-web preflight's SECURITY DEFINER
-- allow-list does not have to grow a fifth reviewed entry. It returns the stored
-- REQUEST and never a resolved worker: resolving is the application's job against
-- the protected queue catalog, and a row that can name a worker is not a worker.
-- The two literal false columns are the database saying so in the result itself.
CREATE VIEW control_project_planner_selections AS
  SELECT s.tenant_id, s.project_id, s.planner_mode, s.planner_worker_id, s.planner_worker_kind,
    s.planner_model, s.planner_effort, s.version AS settings_version, s.updated_at,
    false AS starts_work, false AS grants_execution_authority
  FROM public.control_project_settings s;

-- The web login needs no new SELECT: 0135 already grants it SELECT on the whole
-- settings table, and these columns are part of that row. What it needs is the
-- owner-gated UPDATE, below, so the owner can choose an orchestrator.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT UPDATE (planner_mode, planner_worker_id, planner_worker_kind, planner_model, planner_effort) ON control_project_settings TO control_room_private_web';
  END IF;
END $$;

-- A down migration is intentionally operator-authored and data refusing: it drops
-- only the columns and grants this file added, and refuses while any project has
-- recorded a selection. Production recovery never silently discards the owner's
-- orchestrator choice.
