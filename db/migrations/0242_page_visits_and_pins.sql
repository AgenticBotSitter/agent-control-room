-- MIG-N part 3: the two tiny owner-level tables behind Home's daily tiles.
-- (Navigation + Home §3a: pins first, then most recently opened pages.)
--
-- WHY SERVER-SIDE AND NOT BROWSER STORAGE, stated here because it is the whole
-- justification for the table. The design's own note: recency and pins are
-- OWNER-level, not per-device state — the owner works from the Mac and the
-- phone, and a tile order that differed per browser would be a tile order that
-- is wrong on the device the owner is actually holding. So this is one bounded
-- read and one fire-and-forget upsert per navigation, written by the one
-- component every page already mounts.
--
-- ONE TABLE FOR VISITS, ONE FOR PINS, and not one table with a nullable
-- pinned_at. A pin is not a visit with a flag: visits are a monotonic counter
-- that every page load bumps, while a pin is a deliberate act with an order the
-- owner chose. Combining them would make "most recent" and "pin order" two
-- readings of one row and would force a partial-unique-index workaround to keep
-- a pinned page from being re-ordered by a visit.
--
-- `page_key` IS AN OPAQUE REGISTRY KEY, not a path and not free text. It is
-- CHECKed to the shape app/page-registry.ts uses, so a chore or a visit can
-- never become an arbitrary URL the owner is walked somewhere by, and a registry
-- entry can be renamed or moved without a migration. There is deliberately no
-- foreign key to the registry: that array is a module, not a table, and a
-- database that refused a rename of a nav label because of a key constraint
-- would be the wrong trade.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- ---------------------------------------------------------------------------------------
-- page_visits: one row per (tenant, identity, page) with when it was last opened and
-- how often. The tile rule reads at most the top few, so both reads are bounded and
-- ordered by recency.
-- ---------------------------------------------------------------------------------------
CREATE TABLE page_visits (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  page_key text NOT NULL CHECK (page_key ~ '^[a-z0-9]+(-[a-z0-9]+){0,7}$'),
  owner_identity_id text NOT NULL,
  last_opened_at timestamptz NOT NULL,
  open_count bigint NOT NULL CHECK (open_count >= 1),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, owner_identity_id, page_key),
  FOREIGN KEY (tenant_id, owner_identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT,
  CHECK (last_opened_at <= updated_at),
  -- A visit is an observation, not a claim about work: the counter cannot be
  -- negative or zero, and it cannot run away past the number of page loads a
  -- single session could have produced without the count being wrong.
  CHECK (open_count <= 1000000000)
);

-- The tile read: this owner's most recently opened pages, most recent first. The
-- index is exactly that ordering, so it is a bounded index scan with no sort.
CREATE INDEX page_visits_recent ON page_visits(tenant_id, owner_identity_id, last_opened_at DESC, page_key);

REVOKE ALL ON page_visits FROM PUBLIC;

-- ---------------------------------------------------------------------------------------
-- page_pins: one row per (tenant, identity, page) the owner has pinned. `pinned_at`
-- carries the order, because §3a rule 1 is "owner pins, in the order pinned, up to
-- 3" — so a pin's position is part of what the row records, not something derived
-- from the page key.
-- ---------------------------------------------------------------------------------------
CREATE TABLE page_pins (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  page_key text NOT NULL CHECK (page_key ~ '^[a-z0-9]+(-[a-z0-9]+){0,7}$'),
  owner_identity_id text NOT NULL,
  pinned_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, owner_identity_id, page_key),
  FOREIGN KEY (tenant_id, owner_identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT,
  CHECK (pinned_at <= updated_at)
);

-- The tile read, again exactly the ordering the read needs: pins in the order the
-- owner pinned them.
CREATE INDEX page_pins_ordered ON page_pins(tenant_id, owner_identity_id, pinned_at, page_key);

REVOKE ALL ON page_pins FROM PUBLIC;