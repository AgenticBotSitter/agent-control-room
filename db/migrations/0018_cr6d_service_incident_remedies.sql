ALTER TABLE control_service_incidents
  ADD COLUMN safe_remedy_code text NOT NULL DEFAULT 'inspect_service'
  CHECK (safe_remedy_code ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$');
