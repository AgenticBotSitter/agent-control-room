-- MIG-A (plan v4.3 §2.1): let the Needs-you guard recognise a DIGEST failure scope.
--
-- 0202's guard requires the escalation to be earned, and it proved that by
-- matching the counter's scope_key against the raised request:
--
--   AND c.scope_key LIKE '%:' || NEW.request_key
--
-- That test encodes the scope key's old SPELLING -- `initial:<tenant>:<project>:<key>`
-- -- rather than its meaning, and the spelling has since changed. The failure
-- scope is now a digest (`initial:<hex>` for a request, `project:<hex>` for a
-- project-and-description), for two reasons that this file exists to record:
--
--   1. REACHABILITY. "A planner that fails twice raises Needs-you" has to be
--      reachable from the panel. The browser mints a fresh `orchestrator:<uuid>`
--      idempotency key on every press, so a per-REQUEST scope is a fresh scope at
--      count 1 every time and nothing ever escalates. Measured against the real
--      coordinator with PostgreSQL stores: four presses with a fresh key gave four
--      refusals, four planner runs and no Needs-you item, where three presses on
--      one key gave the correct refuse / needs_you / needs_you.
--   2. LENGTH. The owner adapter accepts a 180-character request key, and
--      `initial:` + a tenant + a project + that key is longer than this table's
--      180-character scope_key CHECK. `record()` would raise 23514, the failure
--      would never be counted, and the second failure could never happen at all.
--
-- A digest is the right shape for both. It is a fixed 8+64 characters whatever
-- the caller's key or description is, and it is not owner-supplied text in a
-- database key.
--
-- WHY THE GUARD HAS TO CHANGE RATHER THAN BE DELETED. The guard's job is to
-- refuse a raise that no live counter earned, so that a caller cannot invent an
-- escalation. Dropping the predicate would leave the counter checks (count >= 2,
-- not cleared) with nothing tying them to THIS request, and any live counter in
-- the project would license any raise. The meaning is preserved exactly: a raise
-- must name a live counter at or above the count it claims, and that counter must
-- be one this request could have incremented.
--
-- HOW THE COUNTERS ARE NAMED, and why this table can verify it. The scope key is
-- a digest over values the RAISE carries, so the trigger can recompute the two
-- keys this request could own and require the live counter to be one of them. The
-- raise row gains `owner_request_digest` -- the digest of the description, never
-- the description -- because the project scope is a digest over (kind, tenant,
-- project, description) and the trigger has to reproduce it. Storing the digest
-- rather than the text keeps the Needs-you ledger content-free, exactly as 0202's
-- header promised: it names the request and the count, never the owner's words.
--
-- `planner_failure_scope_key(text, text, text)` is the single SQL definition of
-- one scope key, used by the trigger below and readable by the application, and
-- `work_intake_canonical_jsonb` (0093) is reused for the digest because that is
-- the canonicaliser the intake login already relies on for identity digests --
-- the application computes the same digest with sha256Digest, which is the same
-- sha256 over the same canonical JSON.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- The description digest the raise carries. NOT NULL with no default: a row
-- inserted by the old code path would carry no description, and an escalation
-- with no description is exactly the unverifiable one, so the column refuses it
-- rather than defaulting to a value that matches nothing.
ALTER TABLE control_planner_needs_you_items
  ADD COLUMN owner_request_digest text NOT NULL
    CHECK (owner_request_digest ~ '^sha256:[a-f0-9]{64}$');

-- One scope key, one definition. `kind` is the literal prefix the coordinator
-- uses ('initial' or 'resplit'); `parts` is the preimage the application digests
-- (the request scope digests {tenantId, projectId, requestKey}, the project scope
-- digests {kind, tenantId, projectId, ownerRequest}). Both are recomputed by the
-- trigger below from values the row carries, so the SQL and the TypeScript
-- produce the same string for the same request -- and the production test in
-- tests/orchestrator-split-suggestions-postgres.test.ts drives the real
-- coordinator through the real stores and requires the raise to be ACCEPTED,
-- which is what holds the two definitions together.
CREATE FUNCTION planner_failure_scope_key(kind text, parts jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT kind || ':' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(public.work_intake_canonical_jsonb(parts),'UTF8')), 'hex');
$$;
REVOKE ALL ON FUNCTION planner_failure_scope_key(text, jsonb) FROM PUBLIC;
COMMENT ON FUNCTION planner_failure_scope_key(text, jsonb) IS
  'The failure scope key for one request, byte-identical to intakeRequestScopeV1/intakeProjectScopeV1 in TypeScript: the same canonical JSON (work_intake_canonical_jsonb is 0093''s, and it sorts object keys exactly as canonicalJson does), the same sha256, the same lowercase hex, the same '':'' separator. pg_catalog.sha256 is PG 11+ and needs no extension; the first draft of this function returned the canonical text instead of its digest and every comparison failed, which is why it is pinned by a test that compares it against the application value.';

-- Rebuild the guard with the digest comparison. The counter checks are
-- unchanged; only the scope match moves from "the key textually ends in this
-- request key" to "this request owns one of the counters it could have
-- incremented", and BOTH the request scope and the project scope are accepted
-- because both are counted by the coordinator and either reaching 2 escalates.
--
-- SECURITY DEFINER, and 0202's original deliberately was NOT. That was correct
-- for the text match -- `LIKE '%:' || NEW.request_key` reads nothing but the row
-- -- and it stops being correct here: the digest comparison calls
-- planner_failure_scope_key, and a plain trigger function runs as the INSERTing
-- role, so without SECURITY DEFINER the coordinator login would need EXECUTE on
-- the helper to be allowed to raise at all (measured: "permission denied for
-- function planner_failure_scope_key" on the first raise).
--
-- It is safe because the function reads only `control_planner_failure_counters`
-- and `control_identities` to CONFIRM what the inserted row claims, and returns
-- a boolean. It writes nothing, returns nothing the caller did not supply, and
-- every input it uses comes from the row the coordinator is inserting -- so it
-- cannot be used to read a counter, an identity or a batch.
CREATE OR REPLACE FUNCTION guard_planner_needs_you_item_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  project_key text;
  request_key_initial text;
  request_key_resplit text;
BEGIN
  project_key := public.planner_failure_scope_key('project', jsonb_build_object(
    'kind', 'initial', 'tenantId', NEW.tenant_id::text, 'projectId', NEW.project_id::text,
    'ownerRequest', NEW.owner_request_digest));
  request_key_initial := public.planner_failure_scope_key('initial', jsonb_build_object(
    'tenantId', NEW.tenant_id::text, 'projectId', NEW.project_id::text, 'requestKey', NEW.request_key::text));
  request_key_resplit := public.planner_failure_scope_key('resplit', jsonb_build_object(
    'tenantId', NEW.tenant_id::text, 'projectId', NEW.project_id::text, 'requestKey', NEW.request_key::text));
  IF NEW.failure_count<2 OR NEW.reason_code<>'orchestrator_failed_twice'
    OR NEW.id<>'planner-needs-you:' || substring(pg_catalog.md5(
      NEW.tenant_id || '/' || NEW.project_id || '/' || NEW.request_key) from 1 for 32)
    OR NOT EXISTS (SELECT 1 FROM public.control_identities i
      WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.raised_by_identity_id
        AND i.actor_type='agent' AND i.state='active')
    -- The escalation must still be TRUE: a raise that does not match a live
    -- counter at or above the count it names is a caller inventing one. The
    -- counter is matched on the RAISED request, not merely the project, so one
    -- project's second failure cannot license another request's escalation.
    OR NOT EXISTS (SELECT 1 FROM public.control_planner_failure_counters c
      WHERE c.tenant_id=NEW.tenant_id AND c.project_id=NEW.project_id
        AND c.failure_count>=NEW.failure_count AND c.cleared_at IS NULL
        AND c.scope_key IN (project_key, request_key_initial, request_key_resplit)) THEN
    RAISE EXCEPTION 'planner needs-you insert rejected';
  END IF;
  RETURN NEW;
END $$;

-- A down migration is intentionally operator-authored and data refusing: it
-- revokes only what this file granted (the two functions), and restores 0202's
-- LIKE-based guard body and the absent column. Restoring it reinstates the
-- spelling test that no longer matches any scope key, so every raise would be
-- refused; the lead runs it on a disposable cluster only.
