-- Keep every id a UUID (ADR-0008). The 20260910000000_add_feedback_flag
-- migration inserted the `feedback` flag with the fixed, cuid-looking id
-- 'cfeedbackflag00000000001'. Nothing references FeatureFlag by id (flags are
-- looked up by their unique `name`), so it can be renamed in place. A fixed
-- UUID keeps databases consistent with each other, like the default Event.
UPDATE "FeatureFlag"
SET "id" = '00000000-0000-4000-8000-000000000002'
WHERE "id" = 'cfeedbackflag00000000001';
