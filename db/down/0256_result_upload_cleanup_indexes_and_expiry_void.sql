-- Revoke exactly what 0256 granted, and nothing else.
--
-- The two indexes go back to 0209's shape: `control_result_upload_sessions_open`
-- is recreated as (tenant_id, expires_at) WHERE state='reserved', the exact index
-- 0209 created, and `control_result_upload_sessions_stopped` — which did not exist
-- before this migration — is dropped.
--
-- The guard body is restored to 0209's, byte for byte: the clock-armed expiry
-- void goes away, so 'expired' is again a value no writer can produce and an
-- abandoned upload is again permanent. That is the pre-0256 state and the point
-- of the rollback: 0209's trigger is unreachable for a dead claim, which is the
-- lock-out this migration exists to fix.
--
-- The clock helper goes with it, because this file is what created it. 0230's
-- result_file_unaccepted_retention_days() is NOT dropped: it predates this
-- migration, and the EXECUTE both helpers now carry is granted in the three
-- module role files rather than here, so there is nothing of that grant for this
-- file to take back.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DROP INDEX control_result_upload_sessions_stopped;
DROP INDEX control_result_upload_sessions_open;
CREATE INDEX control_result_upload_sessions_open
  ON control_result_upload_sessions(tenant_id, expires_at) WHERE state='reserved';

-- No REVOKE here, and that is the point rather than an omission. The EXECUTE on
-- both clock helpers is granted in the three module role files
-- (db/roles/fleet_gateway_roles.sql, native_results_roles.sql,
-- private_web_roles.sql), which this migration's up file does not touch, so there
-- is nothing of that grant for this down file to take back. 0230's
-- result_file_unaccepted_retention_days() keeps its definition and its grant; the
-- two indexes below and the guard body below are everything this migration really
-- added, and exactly what comes back off.

DROP FUNCTION public.result_upload_expired_after_hours();

CREATE OR REPLACE FUNCTION public.guard_result_upload_session_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE mode text;
BEGIN
  IF ROW(NEW.tenant_id,NEW.upload_id,NEW.project_id,NEW.job_id,NEW.attempt_id,NEW.set_id,NEW.ordinal,
      NEW.producer_kind,NEW.worker_id,NEW.claim_id,NEW.expected_size_bytes,NEW.expected_content_digest,
      NEW.chunk_size_bytes,NEW.expected_chunks,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.upload_id,OLD.project_id,OLD.job_id,OLD.attempt_id,OLD.set_id,
      OLD.ordinal,OLD.producer_kind,OLD.worker_id,OLD.claim_id,OLD.expected_size_bytes,
      OLD.expected_content_digest,OLD.chunk_size_bytes,OLD.expected_chunks,OLD.created_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.state,NEW.state) IN (('reserved','received'),('reserved','voided'),('received','published'),
      ('received','voided'))) THEN
    RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.state='voided' AND OLD.void_reason IS NOT NULL THEN
    RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.state='received' AND OLD.state='reserved' THEN
    -- The claim must still be live. An upload that outlives its claim does not
    -- become a promise the owner is ever shown.
    IF NOT public.fleet_claim_is_live(OLD.tenant_id,OLD.claim_id,OLD.worker_id) THEN
      RAISE EXCEPTION 'result upload session rejected' USING ERRCODE = '42501';
    END IF;
    IF NEW.received_at IS NULL OR NEW.received_at<OLD.created_at OR NEW.received_at>OLD.expires_at
      OR NEW.received_at>pg_catalog.statement_timestamp()+interval '1 minute' THEN
      RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
    END IF;
    -- The tiling. Ordinals 1..expected_chunks with no gaps (the primary key
    -- makes a gap and a duplicate the same refusal), no extras, each chunk the
    -- size its position requires, summing to exactly the promised size. The
    -- per-chunk size is the SAME expression the chunk guard and the table's own
    -- CHECK use, so the three cannot drift apart.
    IF (SELECT count(*) FROM public.control_result_upload_chunks c
          WHERE c.tenant_id=OLD.tenant_id AND c.upload_id=OLD.upload_id)<>OLD.expected_chunks
      OR (SELECT coalesce(sum(c.size_bytes),0) FROM public.control_result_upload_chunks c
          WHERE c.tenant_id=OLD.tenant_id AND c.upload_id=OLD.upload_id)<>OLD.expected_size_bytes
      OR EXISTS (SELECT 1 FROM public.control_result_upload_chunks c
          WHERE c.tenant_id=OLD.tenant_id AND c.upload_id=OLD.upload_id
            AND c.size_bytes IS DISTINCT FROM (CASE WHEN c.ordinal<OLD.expected_chunks
              THEN OLD.chunk_size_bytes::bigint
              ELSE OLD.expected_size_bytes-OLD.chunk_size_bytes::bigint*(OLD.expected_chunks-1) END)) THEN
      RAISE EXCEPTION 'result upload session update rejected: chunks do not tile the promise' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Publishing is what 0211 proves against the catalog; the only thing checked
  -- here is that the claim was still live when the bytes were declared whole.
  IF NEW.state='published' AND OLD.state='received' THEN
    IF NEW.published_at IS NULL OR NEW.published_at<OLD.received_at OR NEW.published_at>OLD.expires_at
      OR NEW.published_at>pg_catalog.statement_timestamp()+interval '1 minute' THEN
      RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state='voided' THEN
    IF NEW.voided_at IS NULL OR NEW.voided_at<OLD.created_at
      OR NEW.voided_at>pg_catalog.statement_timestamp()+interval '1 minute' THEN
      RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
    END IF;
    -- A worker's own void needs a live claim over this session: that is a
    -- worker giving up on its own upload, never one cancelling another's.
    -- The ONE void that needs no claim is Stop, because Stop is precisely the
    -- case where there is no claim left to check.
    IF NEW.void_reason='stopped' THEN
      SELECT m.mode INTO mode FROM public.installation_operations_mode_revisions m
        WHERE m.tenant_id=OLD.tenant_id ORDER BY m.revision DESC LIMIT 1;
      IF mode IS DISTINCT FROM 'stopped' THEN
        RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
      END IF;
    ELSIF NOT public.fleet_claim_is_live(OLD.tenant_id,OLD.claim_id,OLD.worker_id) THEN
      RAISE EXCEPTION 'result upload session rejected' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_upload_session_update() FROM PUBLIC;