ALTER TABLE owner_web_push_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_web_push_subscriptions_existing_access ON owner_web_push_subscriptions
  AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
ALTER TABLE owner_web_push_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_web_push_deliveries_existing_access ON owner_web_push_deliveries
  AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
