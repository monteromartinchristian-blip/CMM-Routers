CREATE TABLE visibility_preferences (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  provider_id TEXT,
  product_id TEXT,
  route_id TEXT,
  payload_json TEXT NOT NULL
);

CREATE INDEX visibility_preferences_scope_idx
  ON visibility_preferences(scope, provider_id, product_id, route_id);
