-- #286: the donor strip's schedule source is Crew Corner's published schedule
-- API. The Channel field renames to the Crew Corner event slug and gains an
-- optional Crew Corner stream id. The rename carries existing values as-is:
-- they are stale Horaro slugs — harmless, because an unknown event 404s and
-- the strip hides (D4); operators re-set them.
ALTER TABLE "Channel" RENAME COLUMN "horaro_schedule_slug" TO "schedule_slug";
ALTER TABLE "Channel" ADD COLUMN "schedule_stream_id" INTEGER;
