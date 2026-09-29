-- Rows inserted by raw SQL in earlier migrations (the default Event in
-- 20260928211407_event_channel_identity, the `feedback` flag in
-- 20260910000000_add_feedback_flag) got CURRENT_TIMESTAMP, which SQLite stores as
-- TEXT. Prisma stores DateTime as INTEGER milliseconds, and SQLite sorts every
-- INTEGER before any TEXT, so `ORDER BY created_at` put the oldest Event last.
-- Convert those values to the representation Prisma uses.
UPDATE "Event"
SET "created_at" = CAST(strftime('%s', "created_at") AS INTEGER) * 1000
WHERE typeof("created_at") = 'text';
UPDATE "Event"
SET "updated_at" = CAST(strftime('%s', "updated_at") AS INTEGER) * 1000
WHERE typeof("updated_at") = 'text';
UPDATE "FeatureFlag"
SET "created_at" = CAST(strftime('%s', "created_at") AS INTEGER) * 1000
WHERE typeof("created_at") = 'text';
UPDATE "FeatureFlag"
SET "updated_at" = CAST(strftime('%s', "updated_at") AS INTEGER) * 1000
WHERE typeof("updated_at") = 'text';
