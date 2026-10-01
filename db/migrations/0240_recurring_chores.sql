-- MIG-N part 1: the owner's own recurring chores — the "Due this week" line on
-- Home, and nothing else. (Navigation + Home §3b.)
--
-- WHY THIS IS NOT `control_recurring_rules` (0186). That table exists to PROPOSE
-- an AI-run task, which still needs owner approval before anything executes. A
-- chore such as "Review bot memory" has no AI execution step at all: it is a
-- manual habit with a due date. Reusing the rule table would mean bolting a
-- "no-op, no-approval, no-task" escape hatch onto a pipeline that exists
-- specifically to gate AI work, so this is deliberately a separate, much
-- smaller table. It grants no execution authority whatsoever.
--
-- OWNER-LEVEL, NOT PER-PROJECT, and there is deliberately no project_id column:
-- a weekly memory review is not scoped to one project, and a project-scoped
-- chore would be invisible from Home. Every row belongs to exactly one human
-- identity through the FK below, which is what makes one owner's rows
-- unreadable and unwritable by another.
--
-- "DUE" IS COMPUTED AT READ TIME, NEVER STORED. `now >= next_due(cadence,
-- last_done_at)` AND `(snoozed_until IS NULL OR now >= snoozed_until)`. There is
-- no due_at column and no stored boolean, because a stored due date is a second
-- copy of the cadence that drifts the moment a chore is done, snoozed, or a
-- device's clock moves; the read recomputes it from cron_expression and
-- last_done_at, so "I check it once and don't need to see it again" is exactly
-- what the row says.
--
-- cadence is stored BOTH ways on purpose: plain_schedule is the owner's own words
-- ("every monday at 09:00"), parsed by the same deliberately-small grammar 0186
-- uses (recurring/v1/plain-schedule.ts), and cron_expression is the normalized
-- five-field form calendar evaluation reads. Storing only the plain text would
-- mean re-parsing owner prose on every read to decide whether something is due;
-- storing only the cron would lose the owner's own words, which is what the panel
-- shows back.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE recurring_chores (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- Chore ids are owner-scoped and never reused. `chore:<uuid>` matches the
  -- kebab-prefixed shape 0195 uses for its approvals, so a chore id is
  -- recognisable in a log without a lookup.
  chore_id text NOT NULL CHECK (chore_id ~ '^chore:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 180),
  -- The page this chore is about, as a key from the page registry
  -- (app/page-registry.ts, Stage 1). NOT a foreign key to a URL and NOT free
  -- text: it is an opaque key, so a registry entry can be renamed or a route
  -- moved without a migration, and a chore can never become an arbitrary link
  -- the owner would be walked somewhere by.
  target_page_key text NOT NULL CHECK (char_length(target_page_key) BETWEEN 1 AND 80),
  -- The same plain vocabulary and the same normalized cron 0186 stores for a
  -- recurring RULE. The CHECK is read OFF THE PARSER'S OWN THREE BRANCHES, not
  -- guessed, because a first draft of this file asserted a two-digit minute and
  -- a bare digit for day-of-week and the real cluster refused the very first row
  -- a test inserted. What `parsePlainRecurringScheduleV1` actually emits is
  -- `${minute} ${hour} * * ${dayField}` with minute UNPADDED, hour UNPADDED, and
  -- dayField "*" (every day), "1-5" (weekday) or "0".."6" (one named day). A
  -- CHECK that does not match the parser is not a guard, it is a way to make the
  -- feature unusable, so the three shapes are named here explicitly.
  -- A chore's cadence is never a list of days, a range of minutes or a step,
  -- because the owner's vocabulary (every day / weekday / one named weekday, at
  -- one time) cannot express any of those.
  plain_schedule text NOT NULL CHECK (char_length(plain_schedule) BETWEEN 1 AND 120),
  cron_expression text NOT NULL CHECK (cron_expression ~ '^[0-9]{1,2} [0-9]{1,2} \* \* (\*|[1-5]|[0-6])$'),
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 80),
  owner_identity_id text NOT NULL,
  last_done_at timestamptz,
  -- Snooze is the same bounded future hold 0219 allows for a cursor: it may sit
  -- in the future and never in the past, because a snooze that has already
  -- elapsed is not a snooze but a stale row that would silently re-arm.
  snoozed_until timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, chore_id),
  -- The owner binding. ON DELETE RESTRICT, not CASCADE: a chore is the owner's
  -- own statement about their own week, and it must not be silently deleted by
  -- an identity row going away.
  FOREIGN KEY (tenant_id, owner_identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT,
  -- A chore cannot have been last done AFTER the snooze that is currently
  -- recorded, because the two are written by the same service in one
  -- transaction; a pair that says otherwise is a bug, not a state.
  CHECK (last_done_at IS NULL OR snoozed_until IS NULL OR last_done_at <= snoozed_until)
);

-- The one read a "Due this week" panel needs: this owner's chores, oldest
-- binding first, so the panel is one bounded ordered scan rather than a sort per
-- request. It is NOT a partial index on "due" because due is computed and cannot
-- be indexed; this narrows to the owner instead, and owner_identity_id is the
-- second column so it also serves the ownership check itself.
CREATE INDEX recurring_chores_owner ON recurring_chores(tenant_id, owner_identity_id, created_at, chore_id);

REVOKE ALL ON recurring_chores FROM PUBLIC;