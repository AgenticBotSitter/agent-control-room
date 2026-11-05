-- Provider settings contain route metadata and opaque credential references only.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
CREATE TABLE control_loop_providers (
 tenant_id text NOT NULL REFERENCES tenants(id) CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
 provider_id text NOT NULL CHECK (provider_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
 display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 180 AND display_name !~ '[[:cntrl:]]'),
 base_url text NOT NULL CHECK (length(base_url) BETWEEN 1 AND 300),
 billing_kind text NOT NULL CHECK (billing_kind IN ('subscription','token')),
 secret_ref jsonb NOT NULL CHECK ((jsonb_typeof(secret_ref)='object' AND (
  (secret_ref->>'kind'='launcher' AND secret_ref ?& ARRAY['kind','launcher'] AND secret_ref-ARRAY['kind','launcher']='{}'::jsonb AND jsonb_typeof(secret_ref->'launcher')='string' AND length(secret_ref->>'launcher') BETWEEN 1 AND 180 AND secret_ref->>'launcher' !~ '[[:cntrl:]]') OR
  (secret_ref->>'kind'='macos_keychain' AND secret_ref ?& ARRAY['kind','service','account'] AND secret_ref-ARRAY['kind','service','account']='{}'::jsonb AND secret_ref->>'service'='control-room.provider' AND secret_ref->>'account'=provider_id) OR
  (secret_ref->>'kind'='bitwarden' AND secret_ref ?& ARRAY['kind','item'] AND secret_ref-ARRAY['kind','item']='{}'::jsonb AND jsonb_typeof(secret_ref->'item')='string' AND length(secret_ref->>'item') BETWEEN 1 AND 180 AND secret_ref->>'item' !~ '[[:cntrl:]]')
 )) IS TRUE),
 price_source_url text CHECK (length(price_source_url) BETWEEN 1 AND 300),
 price_source_format text CHECK (price_source_format='control-room.provider-prices/v1'),
 credit_amount_nano_usd text CHECK (credit_amount_nano_usd ~ '^(0|[1-9][0-9]{0,29})$'),
 credit_expires_on date,
 credit_note text NOT NULL CHECK (length(credit_note)<=1000 AND credit_note !~ '[[:cntrl:]]'),
 updated_by text NOT NULL CHECK (updated_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
 updated_at timestamptz NOT NULL,
 PRIMARY KEY (tenant_id,provider_id),
 CHECK ((price_source_url IS NULL)=(price_source_format IS NULL))
);
CREATE TABLE control_loop_provider_models (
 tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
 provider_id text NOT NULL CHECK (provider_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
 roster_name text NOT NULL CHECK (length(roster_name) BETWEEN 1 AND 180 AND roster_name !~ '[[:cntrl:]]'),
 launcher text NOT NULL CHECK (length(launcher) BETWEEN 1 AND 180 AND launcher !~ '[[:cntrl:]]'),
 served_model_id text NOT NULL CHECK (served_model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$'),
 PRIMARY KEY (tenant_id,provider_id,roster_name),
 FOREIGN KEY (tenant_id,provider_id) REFERENCES control_loop_providers(tenant_id,provider_id)
);
CREATE TABLE control_loop_provider_state (
 tenant_id text PRIMARY KEY REFERENCES tenants(id) CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
 version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
 last_idempotency_key text CHECK (last_idempotency_key ~ '^[A-Za-z0-9:_-]{16,100}$'),
 last_request_digest text CHECK (last_request_digest ~ '^sha256:[a-f0-9]{64}$'),
 updated_at timestamptz NOT NULL,
 CHECK ((last_idempotency_key IS NULL)=(last_request_digest IS NULL))
);
