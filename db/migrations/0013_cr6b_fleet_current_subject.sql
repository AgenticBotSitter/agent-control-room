ALTER TABLE control_node_fleet_current
  ADD COLUMN signal_subject_id text NOT NULL DEFAULT 'node'
    CHECK (signal_subject_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$');

UPDATE control_node_fleet_current
SET signal_subject_id = CASE signal_kind
  WHEN 'capability' THEN payload->'payload'->>'probeId'
  WHEN 'benchmark' THEN payload->'payload'->>'benchmarkId'
  ELSE 'node'
END;

ALTER TABLE control_node_fleet_current
  DROP CONSTRAINT control_node_fleet_current_pkey,
  ADD PRIMARY KEY (tenant_id,node_id,signal_kind,signal_subject_id);

CREATE INDEX idx_control_node_fleet_current_subject_freshness
  ON control_node_fleet_current(tenant_id,node_id,signal_kind,signal_subject_id,expires_at);
