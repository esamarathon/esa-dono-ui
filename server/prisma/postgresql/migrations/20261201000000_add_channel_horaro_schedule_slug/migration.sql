-- #148: optional Horaro schedule slug per Channel, for the donor-site
-- "Live / Up next" schedule strip. The Horaro organisation is fixed to "esa"
-- in code; only the schedule slug is stored. Nullable: a Channel without a
-- slug simply gets no schedule strip. Same model as the SQLite migration.
ALTER TABLE "Channel" ADD COLUMN "horaro_schedule_slug" TEXT;
