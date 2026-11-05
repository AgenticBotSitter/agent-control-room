-- Provider price observations contain fixed reason codes, never upstream response text.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
CREATE TABLE control_loop_provider_prices (
 tenant_id text NOT NULL,
 provider_id text NOT NULL,
 model text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$'),
 window_key text NOT NULL CHECK (length(window_key) BETWEEN 1 AND 256),
 "window" jsonb,
 input_nano_usd_per_token text CHECK (input_nano_usd_per_token ~ '^(0|[1-9][0-9]{0,32})$'),
 output_nano_usd_per_token text CHECK (output_nano_usd_per_token ~ '^(0|[1-9][0-9]{0,32})$'),
 currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 status text NOT NULL CHECK (status IN ('known','unknown','not_comparable')),
 reason text NOT NULL CHECK (length(reason)<=64 AND reason ~ '^[a-z_]*$'),
 checked_at timestamptz NOT NULL,
 PRIMARY KEY (tenant_id,provider_id,model,window_key),
 FOREIGN KEY (tenant_id,provider_id) REFERENCES control_loop_providers(tenant_id,provider_id),
 CHECK (("window" IS NULL)=(window_key='all')),
 CHECK ("window" IS NULL OR jsonb_typeof("window")='object'),
 CHECK (status<>'known' OR (currency='USD' AND input_nano_usd_per_token IS NOT NULL AND output_nano_usd_per_token IS NOT NULL)),
 CHECK (status='known' OR (input_nano_usd_per_token IS NULL AND output_nano_usd_per_token IS NULL))
);
CREATE TABLE control_loop_provider_fetches (
 tenant_id text NOT NULL,
 provider_id text NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('ok','failed','not_machine_readable','no_source')),
 reason text NOT NULL CHECK (length(reason)<=64 AND reason ~ '^[a-z_]*$'),
 fetched_at timestamptz NOT NULL,
 PRIMARY KEY (tenant_id,provider_id),
 FOREIGN KEY (tenant_id,provider_id) REFERENCES control_loop_providers(tenant_id,provider_id)
);
