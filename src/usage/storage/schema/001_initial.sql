CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  payload_json TEXT NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  payload_json TEXT NOT NULL
);

CREATE TABLE subscription_periods (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  payload_json TEXT NOT NULL
);

CREATE TABLE model_identities (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);

CREATE TABLE access_routes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  subscription_period_id TEXT REFERENCES subscription_periods(id),
  model_identity_id TEXT REFERENCES model_identities(id),
  payload_json TEXT NOT NULL
);

CREATE TABLE quota_groups (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  payload_json TEXT NOT NULL
);

CREATE TABLE quota_buckets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quota_group_id TEXT REFERENCES quota_groups(id),
  payload_json TEXT NOT NULL
);

CREATE TABLE consumption_rules (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);

CREATE TABLE quota_bindings (
  id TEXT PRIMARY KEY,
  access_route_id TEXT NOT NULL REFERENCES access_routes(id),
  quota_bucket_id TEXT NOT NULL REFERENCES quota_buckets(id),
  consumption_rule_id TEXT REFERENCES consumption_rules(id),
  payload_json TEXT NOT NULL
);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  access_route_id TEXT REFERENCES access_routes(id),
  model_identity_id TEXT REFERENCES model_identities(id),
  payload_json TEXT NOT NULL
);

CREATE TABLE cost_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  access_route_id TEXT REFERENCES access_routes(id),
  payload_json TEXT NOT NULL
);

CREATE TABLE quota_snapshots (
  id TEXT PRIMARY KEY,
  quota_bucket_id TEXT NOT NULL REFERENCES quota_buckets(id),
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX idx_subscription_periods_product ON subscription_periods(product_id);
CREATE INDEX idx_access_routes_product ON access_routes(product_id);
CREATE INDEX idx_quota_bindings_route ON quota_bindings(access_route_id);
CREATE INDEX idx_quota_snapshots_bucket_observed ON quota_snapshots(quota_bucket_id, observed_at DESC);
CREATE INDEX idx_usage_events_occurred ON usage_events(occurred_at DESC);
