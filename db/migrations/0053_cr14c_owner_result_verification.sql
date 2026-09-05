-- Preserve the existing private review boundary and admit only human verification evidence.
-- This does not grant INSERT privileges, create profiles/targets, or permit job transitions.
CREATE OR REPLACE FUNCTION guard_private_web_quality_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web'
    AND pg_has_role(current_user,oid,'MEMBER'))
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    IF NEW.kind NOT IN ('review','finding','verification')
      OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id
      OR NEW.payload->>'projectId' IS DISTINCT FROM NEW.project_id
      OR NEW.payload->>'id' IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'private quality insert rejected';
    END IF;
    IF NEW.kind='review' AND (
      NEW.payload->>'authority' IS DISTINCT FROM 'completion_gate'
      OR coalesce(NEW.payload->>'decision','') NOT IN ('accepted','changes_requested')
      OR NEW.payload->'reviewer'->>'actorType' IS DISTINCT FROM 'human'
      OR NEW.payload->>'grantsApproval' IS DISTINCT FROM 'false'
      OR NEW.payload->>'grantsExecutionAuthority' IS DISTINCT FROM 'false') THEN
      RAISE EXCEPTION 'private quality insert rejected';
    END IF;
    IF NEW.kind='verification' AND (
      coalesce(NEW.payload->>'outcome','') NOT IN ('passed','failed','blocked','inconclusive')
      OR NEW.payload->'verifier'->>'actorType' IS DISTINCT FROM 'human'
      OR coalesce(NEW.payload->'verifier'->>'actorId','')=''
      OR NEW.payload->>'grantsApproval' IS DISTINCT FROM 'false'
      OR NEW.payload->>'grantsExecutionAuthority' IS DISTINCT FROM 'false') THEN
      RAISE EXCEPTION 'private quality insert rejected';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_private_web_quality_insert() FROM PUBLIC;
