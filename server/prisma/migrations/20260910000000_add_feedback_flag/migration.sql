-- Insert the `feedback` feature flag row (disabled by default) so it shows
-- up as toggleable in the admin UI. A missing row already resolves to
-- disabled via isFeatureFlagEnabled(), so this is purely for visibility —
-- idempotent via INSERT OR IGNORE (name is unique).
INSERT OR IGNORE INTO "FeatureFlag" ("id", "name", "description", "is_enabled", "created_at", "updated_at")
VALUES (
  'cfeedbackflag00000000001',
  'feedback',
  'Floating widget letting visitors send a screenshot + free-text message to the team via Discord.',
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
