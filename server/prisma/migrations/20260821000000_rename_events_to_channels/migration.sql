-- Rename the Event concept to Channel (naming only; no behavior change).
ALTER TABLE "Event" RENAME TO "Channel";
ALTER TABLE "Reward" RENAME COLUMN "event_id" TO "channel_id";
ALTER TABLE "Poll" RENAME COLUMN "event_id" TO "channel_id";
ALTER TABLE "FundGoal" RENAME COLUMN "event_id" TO "channel_id";
ALTER TABLE "Donation" RENAME COLUMN "event_id" TO "channel_id";
ALTER TABLE "PendingPledge" RENAME COLUMN "event_id" TO "channel_id";
