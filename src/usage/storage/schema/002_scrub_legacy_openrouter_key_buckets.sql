-- CMM Usage originally used OpenRouter's current-key label as part of quota
-- bucket identity. Labels are not a safe persistent identity and may contain
-- user-controlled or key-like material. Remove every pre-v2 OpenRouter
-- per-key bucket and its dependent rows once. The next successful discovery
-- recreates current-key buckets with the stable `current` owner and, when a
-- management credential is configured, recreates management-key buckets from
-- their provider hash.

DELETE FROM quota_snapshots
WHERE quota_bucket_id IN (
  SELECT id
  FROM quota_buckets
  WHERE product_id = 'product:openrouter-credits'
    AND id LIKE 'bucket:openrouter:key%3A%'
);

DELETE FROM quota_bindings
WHERE quota_bucket_id IN (
  SELECT id
  FROM quota_buckets
  WHERE product_id = 'product:openrouter-credits'
    AND id LIKE 'bucket:openrouter:key%3A%'
);

DELETE FROM quota_buckets
WHERE product_id = 'product:openrouter-credits'
  AND id LIKE 'bucket:openrouter:key%3A%';
