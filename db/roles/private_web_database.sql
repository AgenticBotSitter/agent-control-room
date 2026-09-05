-- Separate operator-owned database ACL step. Never invoked by startup.
-- Apply only to the exact, dedicated database covered by the setup approval.
DO $$ BEGIN
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;
