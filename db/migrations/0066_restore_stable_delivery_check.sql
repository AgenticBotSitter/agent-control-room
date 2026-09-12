-- PostgreSQL expands BETWEEN into a nested conjunction when first parsing 0036,
-- but flattens it when reparsing pg_dump output. Spell out the identical bounds
-- so source and repeated restores share one stable catalog representation.
-- Preserve the exact constraint name, range, regex and NULL semantics. This
-- single ALTER is atomic and validates existing rows; no NOT VALID shortcut.
ALTER TABLE control_connection_enrollment_protocol_deliveries
  DROP CONSTRAINT control_connection_enrollment_protocol_delive_delivery_id_check,
  ADD CONSTRAINT control_connection_enrollment_protocol_delive_delivery_id_check
    CHECK (char_length(delivery_id) >= 3 AND char_length(delivery_id) <= 160
      AND delivery_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$');

-- The article-size check introduced in 0065 uses the same conjunction shape.
-- Flatten its inclusive bounds too, retaining the explicit NULL refusal.
ALTER TABLE control_abs_article_details
  DROP CONSTRAINT control_abs_article_details_payload_check,
  ADD CONSTRAINT control_abs_article_details_payload_check CHECK (COALESCE(
    jsonb_typeof(payload) = 'object' AND payload->>'status' = 'extracted'
    AND jsonb_typeof(payload->'text') = 'string'
    AND octet_length(payload->>'text') >= 1
    AND octet_length(payload->>'text') <= 131072, false));
