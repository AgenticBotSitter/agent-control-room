-- MIG-I: the subscriptions table may only hold real push-service endpoints.
--
-- src/web-push/v1/policy.ts refuses a non-allow-listed endpoint at SUBSCRIBE
-- time, and channel.ts refuses it again at SEND time. This migration is the
-- third, independent check, and it is the one that holds against a writer that
-- is neither: anything holding INSERT on owner_web_push_subscriptions, or a
-- row written before the allow list existed, is caught here rather than being
-- dialled by the dispatcher on its own schedule.
--
-- Why it matters today rather than after the VAPID key moves to the updater
-- (UPDATE_SAFETY_DESIGN §12/R12). The key is already on the web process, and the
-- web process already makes an outbound VAPID-signed POST to whatever endpoint a
-- row names. Without a host constraint that is a live SSRF primitive, reachable
-- by anything that can get an owner session -- a compromised or XSS'd owner
-- browser. What R12 defers is moving the key, not the allow list.
--
-- The constraint matches the PARSED host, never a substring of the URL. A
-- substring or a LIKE test would accept
--   https://evil.invalid/?next=web.push.apple.com
--   https://web.push.apple.com.evil.invalid/
-- which is the same refusal with extra steps.
--
-- PostgreSQL has no URL parser in a CHECK, so the host is extracted textually
-- below. That extraction is the delicate part, so it is written to fail CLOSED:
-- anything whose authority is not exactly `host` or `host:443`, with no
-- credential and no fragment, yields NULL, and NULL is refused. A
-- representation the extraction does not understand is therefore refused rather
-- than admitted with a host the extraction guessed. `owner_push_endpoint_host`
-- is exercised directly, with these exact strings, in
-- tests/owner-push-migrations-postgres.test.ts -- including against the
-- production owner-web login, so this is not a rule asserted only in a comment.
--
-- The three lists (this file, policy.ts, channel.ts) must agree. They are
-- asserted to agree, string for string, by the same test: a version of this
-- migration that drifts from the application would start refusing a subscribe
-- the application considered valid, which is a worse failure than the SSRF it
-- prevents.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- The lowercased host of an HTTPS push endpoint, or NULL when it cannot be
-- established beyond doubt.
--
-- TOTAL by construction: every input yields a host or NULL and never an error,
-- so a hostile string cannot turn a CHECK into a crash and the refusal always
-- happens in the CHECK, in one readable place.
--
-- The search_path is pinned for the same reason 0225 pins its guard's: a CHECK
-- runs with the privileges of the WRITER, so a function resolving a name
-- through the caller's search_path is an injection point reachable by anyone
-- who can INSERT here. pg_temp last means no writable schema is searched.
CREATE FUNCTION owner_push_endpoint_host(text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    -- Not https, so not a push endpoint at all. 0173's own CHECK already
    -- refuses this; repeated here so the function is safe to call alone.
    WHEN value !~ '^https://' THEN NULL
    -- A credential in the URL: credential material, not a shape question.
    WHEN value ~ '^https://[^/?#]*@' THEN NULL
    -- A fragment. No real push service issues one. A QUERY is deliberately NOT
    -- refused: a real Windows Notification Services channel URL is
    -- `https://<label>.notify.windows.com/?token=...`, and refusing queries
    -- would refuse every real Windows subscription. A query is not an SSRF
    -- vector here either -- the host is read from the authority, which ends at
    -- the first '/', '?' or '#', so `https://evil.invalid/?next=web.push.apple.com`
    -- is the host `evil.invalid` and the list refuses it on the host alone.
    WHEN value ~ '#' THEN NULL
    -- The authority, taken as everything up to the first '/', '?' or '#'.
    ELSE CASE
      WHEN substring(value from '^https://([^/?#]*)') !~ '^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*)(:443)?$'
        THEN NULL
      ELSE lower(split_part(substring(value from '^https://([^/?#]*)'), ':', 1))
    END
  END
  FROM (SELECT $1 AS value) AS input
$$;
REVOKE ALL ON FUNCTION owner_push_endpoint_host(text) FROM PUBLIC;
COMMENT ON FUNCTION owner_push_endpoint_host(text) IS
  'The lowercased host of an HTTPS push endpoint, or NULL when it cannot be established.';

-- The four known push services, matched on the WHOLE host. The Windows entry is
-- the only wildcard, because Windows Notification Services issues
-- per-notification hosts under its own domain and an exact-host list would
-- refuse a real subscription. It is one DNS label in front, so this admits
-- neither a bare "notify.windows.com" nor "x.notify.windows.com.evil.invalid".
CREATE FUNCTION owner_push_endpoint_allowed(text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(owner_push_endpoint_host($1) = ANY (ARRAY[
      'web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'])
    OR owner_push_endpoint_host($1) ~ '^[a-z0-9-]+\.notify\.windows\.com$', false)
$$;
-- EXECUTE is granted to the login that INSERTS, because a CHECK runs as its
-- writer: without this the constraint is unevaluable by the very role it exists
-- to constrain, and every subscribe fails 42501 instead of 204. This is
-- deliberately the only privilege either function has -- the functions are pure
-- and reveal nothing, and they are what the constraint needs.
--
-- Guarded on the role existing, exactly as 0226's grants are: this migration is
-- also read by the schema-only paths, where a bare GRANT to a missing role is a
-- hard error and would abort an upgrade for a reason that has nothing to do with
-- the allow list.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION owner_push_endpoint_host(text) TO control_room_private_web';
    EXECUTE 'GRANT EXECUTE ON FUNCTION owner_push_endpoint_allowed(text) TO control_room_private_web';
  END IF;
END $$;
COMMENT ON FUNCTION owner_push_endpoint_allowed(text) IS
  'True when the endpoint is HTTPS on a known push service. NULL host means false, never true.';

-- A NOT VALID constraint, deliberately not followed by VALIDATE.
--
-- NOT VALID takes only a brief lock and, crucially, holds every NEW row from
-- this moment on. That is the whole of the constraint's security job here: an
-- off-list endpoint can no longer be INSERTed by anything, including anything
-- the application itself does not check.
--
-- It is left NOT VALID on purpose. The rows it does not cover are INERT rather
-- than dangerous -- channel.ts refuses an off-list endpoint at send time, so an
-- old row cannot be dialled whether or not the database holds it to the list --
-- and every migration file runs in ONE transaction, so a VALIDATE that found
-- one bad row would roll back this entire migration and abort the upgrade. The
-- owner would be told their database is broken by a constraint added to stop a
-- problem they do not have, in exchange for no additional protection.
--
-- A row the list would refuse is counted and named below so it is a visible,
-- actionable thing rather than a silent one, and the remediation is in the
-- message: unsubscribe that browser and subscribe it again.
ALTER TABLE owner_web_push_subscriptions ADD CONSTRAINT owner_web_push_subscriptions_endpoint_allowed
  CHECK (owner_push_endpoint_allowed(endpoint)) NOT VALID;

COMMENT ON CONSTRAINT owner_web_push_subscriptions_endpoint_allowed ON owner_web_push_subscriptions IS
  'An endpoint must be HTTPS on a known push service. NOT VALID by choice: it holds every new row, '
  'and rows that predate the list are inert because channel.ts refuses them at send time. '
  'Validating here would abort the upgrade transaction for no added protection.';

DO $$ DECLARE refused bigint;
BEGIN
  SELECT count(*) INTO refused FROM owner_web_push_subscriptions
    WHERE NOT owner_push_endpoint_allowed(endpoint);
  IF refused > 0 THEN
    RAISE WARNING 'owner push endpoint allow list: % existing subscription(s) on a host outside the list are retained and will not be sent to; unsubscribe that browser and subscribe it again',
      refused;
  END IF;
END $$;
