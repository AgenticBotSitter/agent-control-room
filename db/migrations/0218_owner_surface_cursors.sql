-- MIG-G: one durable last-seen cursor per owner-facing surface. A missing row
-- means "from now"; reads never create or advance one.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE owner_surface_cursors (
  tenant_id text NOT NULL,
  identity_id text NOT NULL,
  surface text NOT NULL CHECK (surface IN ('home','morning')),
  seen_through timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,identity_id,surface),
  FOREIGN KEY (tenant_id,identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  CHECK (updated_at>=seen_through)
);

REVOKE ALL ON owner_surface_cursors FROM PUBLIC;
