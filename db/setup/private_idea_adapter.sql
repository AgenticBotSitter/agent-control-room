-- OFFLINE OPERATOR SETUP ONLY, in the approved dedicated database.
-- Set the session-only control_room.setup_tenant_id to the reviewed tenant first.
-- Never run from application startup. Existing registrations are not overwritten.
BEGIN;
DO $$
DECLARE target_tenant text := current_setting('control_room.setup_tenant_id', true);
BEGIN
  IF target_tenant IS NULL OR target_tenant = '' OR NOT EXISTS
    (SELECT 1 FROM tenants WHERE id = target_tenant) THEN
    RAISE EXCEPTION 'private_idea_adapter_setup_invalid';
  END IF;
  INSERT INTO adapter_registry(id, tenant_id, source_system, contract_version,
    authority_mode, status, project_types, supported_read_operations,
    supported_commands, redaction_policy_version, cursor_retention_days)
  VALUES ('adapter.control-room-native-ideas', target_tenant,
    'control_room_native_ideas', '1.0.0', 'control_room_native', 'pending',
    '["business_validation"]'::jsonb, '["read_project"]'::jsonb,
    '[]'::jsonb, 'v1', 30);
END $$;
COMMIT;
