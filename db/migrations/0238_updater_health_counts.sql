-- Updater health counts: the updater's INDEPENDENT read of the three owner-facing
-- counts in design §8.4 item 2, as counts only.
--
-- WHY THIS IS A FUNCTION AND NOT A GRANT. §8.4 says the counts the web login
-- reports are "compared with the updater's own reads". The obvious implementation
-- -- GRANT SELECT on `projects` / `control_update_candidates` to
-- control_room_deployer -- is refused twice over:
--   * src/updater/v1/schema-installer.ts fails the updater AT STARTUP if the
--     deployer can reach any release table beyond the three columns of
--     control_web_sessions / control_identities / control_role_grants
--     (db/roles/updater_release_reader_roles.sql), and
--   * R10a holds those tables are owned by control_room_schema_owner precisely so
--     that the login holding the owner's approval authority cannot read
--     candidate-controlled release rows. Widening it to a table a candidate's SQL
--     can rewrite is the exact authority growth R10a exists to prevent.
-- So the updater gets a SECURITY DEFINER function owned by the schema owner, and
-- a grant to EXECUTE. That is the same shape as read_agent_review_plan
-- (db/migrations/0106) and redeem_fleet_enrollment (db/migrations/0141): a narrow
-- boundary that answers one question without handing over a table.
--
-- WHY IT TAKES NO ARGUMENTS. §8.4's authority read is "pre-bound to the live
-- tenant/workspace". A tenant argument would be a caller-chosen scope for a
-- login the design gives no other way to scope, and a hostile local process that
-- reached this login could then ask about any tenant. The singleton
-- work_intake_tenant_binding row already records the one tenant this
-- installation serves, so the scope comes from the database and there is nothing
-- left for the caller to choose. The workspace is derived from that tenant's
-- projects the same way the web's own scope is fixed at install.
--
-- COUNTS ONLY, NEVER CONTENT. Each branch is a count() over the same predicate,
-- limit and join the UI read uses, so the two agree by construction rather than by
-- two implementations drifting. Nothing in the return type is a name, an id, a
-- path, a payload or a row: three bigints, nothing else.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE FUNCTION updater_health_counts()
RETURNS TABLE(home_summary_count bigint, project_count bigint, updates_panel_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  -- The one tenant this installation serves, its single workspace, and the
  -- manual adapter id derived from them exactly as the web derives it
  -- (src/web/v1/project-service.ts manualAdapterId: 'adapter:manual:' +
  -- sha256Digest({tenantId, workspaceId}).slice(7, 39)).
  --
  -- `sha256Digest` canonicalizes to sorted-key JSON, so the bytes hashed here are
  -- {"tenantId":"<t>","workspaceId":"<w>"} with no spaces -- written literally
  -- rather than assembled, because a concatenated guess at the canonical form is
  -- exactly the kind of drift this function exists to prevent. The substring is
  -- [7:39] of 'sha256:<64 hex>', i.e. the first 32 hex characters of the digest,
  -- which is characters 7..39 of the prefixed string.
  --
  -- SCOPE IS ONE ROW OR NONE. `workspaces` has no unique constraint on tenant_id
  -- alone (only UNIQUE(tenant_id, id), which id itself satisfies), so a join
  -- here could yield one scope row per workspace and multiply every count below.
  -- `WHERE b.singleton` plus `count(*) OVER () = 1` pins the shape: a binding row
  -- whose tenant has more than one workspace produces NO row, and the caller sees
  -- zero counts, which fails §8.4's count comparison closed rather than reporting
  -- an inflated number. A missing binding row behaves the same way.
  --
  -- The workspace comes from the binding row joined to the tenant's own single
  -- workspace rather than from an argument, so there is no caller-chosen scope
  -- anywhere in this boundary.
  WITH scope AS (
    SELECT b.tenant_id, w.id AS workspace_id,
      'adapter:manual:' || pg_catalog.substr(pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to('{"tenantId":"' || b.tenant_id || '","workspaceId":"' || w.id || '"}', 'UTF8')),
        'hex'), 1, 32) AS manual_adapter
    FROM public.work_intake_tenant_binding b
    JOIN public.workspaces w ON w.tenant_id = b.tenant_id
    WHERE b.singleton
      AND (SELECT count(*) FROM public.workspaces x WHERE x.tenant_id = b.tenant_id) = 1
  )
  SELECT
    -- (1) Home: the two-branch read in WebTaskService.home (src/web/v1/
    -- task-service.ts). Active rows are the job states Home lists, ordered by
    -- updated_at DESC, id COLLATE "C", LIMIT 251; result rows are the newest
    -- artifacts for those jobs, LIMIT 11. The counts are of those two bounded
    -- sets, which is what the page renders, so the cap is part of the answer and
    -- not an implementation detail that could drift.
    (SELECT count(*) FROM (
       SELECT j.id FROM public.control_jobs j
       JOIN public.projects p ON p.tenant_id = j.tenant_id AND p.id = j.project_id
       WHERE j.tenant_id = s.tenant_id AND p.workspace_id = s.workspace_id
         AND EXISTS (SELECT 1 FROM public.control_manual_project_heads h
                     WHERE h.tenant_id = p.tenant_id AND h.project_id = p.id)
         AND j.state IN ('leased','running','waiting_approval')
       ORDER BY j.updated_at DESC, j.id COLLATE "C" LIMIT 251
     ) home_active) + (SELECT count(*) FROM (
       SELECT a.artifact_id FROM public.control_native_artifact_receipts a
       JOIN public.control_artifact_manifests m ON m.tenant_id = a.tenant_id AND m.id = a.artifact_id
       JOIN public.projects p ON p.tenant_id = a.tenant_id AND p.id = a.project_id
       WHERE a.tenant_id = s.tenant_id AND p.workspace_id = s.workspace_id
         AND EXISTS (SELECT 1 FROM public.control_manual_project_heads h
                     WHERE h.tenant_id = p.tenant_id AND h.project_id = p.id)
       ORDER BY m.created_at DESC, a.artifact_id COLLATE "C" LIMIT 11
     ) home_results)
    ,
    -- (2) Projects: WebProjectService.list (src/web/v1/project-service.ts) --
    -- the tenant+workspace catalog of manual projects, joined to their heads,
    -- ordered by id, LIMIT 201. 201 is the UI's "one more than the page" cap,
    -- and the service throws past 200 rather than truncating; the count is taken
    -- at the same bound so the two agree on what "the project list" was.
    (SELECT count(*) FROM (
       SELECT p.id FROM public.projects p
       JOIN public.control_manual_project_heads h ON h.tenant_id = p.tenant_id AND h.project_id = p.id
       WHERE p.tenant_id = s.tenant_id AND p.workspace_id = s.workspace_id
         AND p.adapter_id = s.manual_adapter
       ORDER BY p.id COLLATE "C" LIMIT 201
     ) catalog),
    -- (3) Updates panel: ImproveControlRoomDeskServiceV1.ready
    -- (src/improve-control-room/v1/service.ts) -- the owner's candidate queue,
    -- tenant-scoped, state='ready', newest first, LIMIT 100.
    (SELECT count(*) FROM (
       SELECT c.id FROM public.control_update_candidates c
       WHERE c.tenant_id = s.tenant_id AND c.state = 'ready'
       ORDER BY c.created_at DESC, c.id DESC LIMIT 100
     ) panel)
  FROM scope s;
$$;

REVOKE ALL ON FUNCTION updater_health_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION updater_health_counts() FROM control_room_private_web;
REVOKE ALL ON FUNCTION updater_health_counts() FROM control_room_task_coordinator;
-- The updater's login is the only caller, and it is created by the updater's own
-- fixed DDL, so the GRANT is a no-op until it exists (it is applied again by the
-- installer after the updater has run for the first time).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'control_room_deployer') THEN
    GRANT EXECUTE ON FUNCTION updater_health_counts() TO control_room_deployer;
  END IF;
END;
$$;

-- The boundary is asserted at grant time, where an operator can see why, rather
-- than only at updater startup. Each of these is what would make this function a
-- hole instead of a boundary:
--   * SECURITY DEFINER with a pinned search_path, or candidate SQL could shadow
--     an object the body names (R10b);
--   * STABLE and no table arguments, so it cannot be turned into a proxy for an
--     arbitrary SELECT through the definer's rights;
--   * no PUBLIC EXECUTE -- without this any login could ask;
--   * exactly one non-owner grantee, and it is the deployer. A second grantee, or
--     a grantable EXECUTE, would hand the counts (and this definer's reach) to
--     somebody the design does not name.
DO $$
DECLARE
  fn regprocedure := 'public.updater_health_counts()'::regprocedure;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = fn) THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = fn
      AND p.prosecdef AND p.provolatile = 's' AND p.prokind = 'f' AND p.pronargs = 0
      AND p.proparallel = 'u' AND NOT p.proleakproof
      AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
      AND pg_catalog.pg_get_userbyid(p.proowner) = 'control_room_schema_owner')
    THEN
    RAISE EXCEPTION 'updater health count function must be STABLE SECURITY DEFINER owned by the schema owner'
      USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.has_function_privilege('public', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'updater health count function must not be executable by PUBLIC' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE((SELECT p.proacl FROM pg_catalog.pg_proc p
        WHERE p.oid = fn), pg_catalog.acldefault('f', (SELECT p.proowner FROM pg_catalog.pg_proc p
        WHERE p.oid = fn)))) a
      WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> 0
        AND pg_catalog.pg_get_userbyid(a.grantee) <> 'control_room_deployer') THEN
    RAISE EXCEPTION 'updater health count function has an unexpected EXECUTE grantee' USING ERRCODE = '42501';
  END IF;
END;
$$;