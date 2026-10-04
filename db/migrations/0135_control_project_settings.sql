-- Owner-editable per-project settings (Cook stream W3b): which configured worker kinds may
-- claim this project's work, how many of its tasks may be assigned at once, and the default
-- worker/model/effort offered when proposing a task. The installation-wide owner-review profile
-- is not stored here: a single-owner install has exactly one reviewer, so review policy stays a
-- fixed, read-only installation setting (mac-local-owner-review-profile.ts), never a per-project
-- override. An absent row means "unrestricted, no cap, no default" -- every project this migration
-- finds keeps today's behavior exactly, with no settings row and nothing to migrate.
CREATE TABLE control_project_settings (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  eligible_worker_kinds jsonb,
  max_concurrent_tasks integer,
  default_worker_kind text,
  default_model text,
  default_effort text,
  version integer NOT NULL,
  updated_by_identity_id text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by_identity_id) REFERENCES control_identities(tenant_id, id),
  CHECK (version >= 1),
  CHECK (max_concurrent_tasks IS NULL OR max_concurrent_tasks BETWEEN 1 AND 20),
  CHECK (default_worker_kind IS NULL OR default_worker_kind IN ('codex','claude-code','hermes')),
  CHECK (default_model IS NULL OR default_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$'),
  CHECK (default_effort IS NULL OR default_effort IN ('default','low','medium','high','xhigh','max')),
  -- A default model/effort without naming the worker it is for is ambiguous: refuse it outright
  -- rather than guess which harness's model namespace it belongs to.
  CHECK ((default_model IS NULL AND default_effort IS NULL) OR default_worker_kind IS NOT NULL),
  -- Every eligible kind is one of the three mac-local harnesses; an empty array (as opposed to
  -- NULL/absent) means "no worker kind is eligible," a deliberately expressible owner choice,
  -- not the same as "not configured." A CHECK constraint cannot hold a subquery, so this uses
  -- jsonb array containment rather than jsonb_array_elements_text; the application layer is what
  -- keeps a saved array de-duplicated and sorted (redundant duplicates would not break this check).
  CHECK (eligible_worker_kinds IS NULL OR (jsonb_typeof(eligible_worker_kinds)='array'
    AND eligible_worker_kinds <@ '["codex","claude-code","hermes"]'::jsonb))
);
