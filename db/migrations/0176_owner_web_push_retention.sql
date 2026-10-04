-- The product may prune terminal rows older than 90 days; subscriptions are removed only by the owner or a permanent push failure.
CREATE INDEX owner_web_push_subscriptions_tenant_updated ON owner_web_push_subscriptions(tenant_id,updated_at DESC);
