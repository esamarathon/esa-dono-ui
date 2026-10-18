-- ADR-0012: every incentive belongs to exactly one Event.
-- Owner: the Channel's Event; else the only Event; else the one Event with
-- allocations. Anything else leaves event_id NULL, the NOT NULL rebuild fails
-- and the transaction changes nothing (docs/deployment.md lists the query).
-- Atomic schema/backfills; foreign keys must be disabled before SQLite rebuilds.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;

-- Distinct Events in which each incentive has allocations, directly through a
-- donation or through a Pool credit batch.
CREATE TEMP TABLE "_IncentiveEvent" AS
SELECT DISTINCT "kind", "id", "event_id" FROM (
  SELECT 'Reward' AS "kind", c."reward_id" AS "id", d."event_id" AS "event_id"
    FROM "RewardClaim" c JOIN "Donation" d ON d."id" = c."donation_id"
  UNION ALL
  SELECT 'Reward', c."reward_id", b."event_id"
    FROM "RewardClaim" c
    JOIN "PoolCreditRedemption" r ON r."claim_id" = c."id"
    JOIN "PoolCreditBatch" b ON b."id" = r."batch_id"
  UNION ALL
  SELECT 'Poll', v."poll_id", d."event_id"
    FROM "PollVote" v JOIN "Donation" d ON d."id" = v."donation_id"
  UNION ALL
  SELECT 'Poll', v."poll_id", b."event_id"
    FROM "PollVote" v
    JOIN "PoolCreditRedemption" r ON r."vote_id" = v."id"
    JOIN "PoolCreditBatch" b ON b."id" = r."batch_id"
  UNION ALL
  SELECT 'FundGoal', f."goal_id", d."event_id"
    FROM "FundContribution" f JOIN "Donation" d ON d."id" = f."donation_id"
  UNION ALL
  SELECT 'FundGoal', f."goal_id", b."event_id"
    FROM "FundContribution" f
    JOIN "PoolCreditRedemption" r ON r."contribution_id" = f."id"
    JOIN "PoolCreditBatch" b ON b."id" = r."batch_id"
) WHERE "event_id" IS NOT NULL;

-- RedefineTables
CREATE TABLE "new_Auction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "custom_type_label" TEXT,
    "image_url" TEXT,
    "starting_price_cents" INTEGER NOT NULL,
    "min_increment_cents" INTEGER NOT NULL,
    "current_bid_cents" INTEGER,
    "current_bidder_id" TEXT,
    "ends_at" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "current_offer_id" TEXT,
    "channel_id" TEXT,
    "event_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Auction_current_offer_id_fkey" FOREIGN KEY ("current_offer_id") REFERENCES "AuctionOffer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Auction_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Auction_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Auction_current_bidder_id_fkey" FOREIGN KEY ("current_bidder_id") REFERENCES "Donor" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Auction" ("channel_id", "created_at", "current_bid_cents", "current_bidder_id", "current_offer_id", "custom_type_label", "description", "ends_at", "id", "image_url", "is_active", "min_increment_cents", "starting_price_cents", "status", "title", "type", "updated_at", "event_id") SELECT "old"."channel_id", "old"."created_at", "old"."current_bid_cents", "old"."current_bidder_id", "old"."current_offer_id", "old"."custom_type_label", "old"."description", "old"."ends_at", "old"."id", "old"."image_url", "old"."is_active", "old"."min_increment_cents", "old"."starting_price_cents", "old"."status", "old"."title", "old"."type", "old"."updated_at",
  COALESCE(
    (SELECT "Channel"."event_id" FROM "Channel" WHERE "Channel"."id" = "old"."channel_id"),
    CASE WHEN (SELECT COUNT(*) FROM "Event") = 1 THEN (SELECT "id" FROM "Event") END,
    CASE WHEN (SELECT COUNT(*) FROM "_IncentiveEvent" e WHERE e."kind" = 'Auction' AND e."id" = "old"."id") = 1
      THEN (SELECT e."event_id" FROM "_IncentiveEvent" e WHERE e."kind" = 'Auction' AND e."id" = "old"."id") END
  )
FROM "Auction" AS "old";
DROP TABLE "Auction";
ALTER TABLE "new_Auction" RENAME TO "Auction";
CREATE UNIQUE INDEX "Auction_current_offer_id_key" ON "Auction"("current_offer_id");
CREATE TABLE "new_FundGoal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "target_cents" INTEGER NOT NULL,
    "current_cents" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_complete" BOOLEAN NOT NULL DEFAULT false,
    "channel_id" TEXT,
    "event_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "FundGoal_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FundGoal_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_FundGoal" ("channel_id", "created_at", "current_cents", "description", "id", "is_active", "is_complete", "target_cents", "title", "updated_at", "event_id") SELECT "old"."channel_id", "old"."created_at", "old"."current_cents", "old"."description", "old"."id", "old"."is_active", "old"."is_complete", "old"."target_cents", "old"."title", "old"."updated_at",
  COALESCE(
    (SELECT "Channel"."event_id" FROM "Channel" WHERE "Channel"."id" = "old"."channel_id"),
    CASE WHEN (SELECT COUNT(*) FROM "Event") = 1 THEN (SELECT "id" FROM "Event") END,
    CASE WHEN (SELECT COUNT(*) FROM "_IncentiveEvent" e WHERE e."kind" = 'FundGoal' AND e."id" = "old"."id") = 1
      THEN (SELECT e."event_id" FROM "_IncentiveEvent" e WHERE e."kind" = 'FundGoal' AND e."id" = "old"."id") END
  )
FROM "FundGoal" AS "old";
DROP TABLE "FundGoal";
ALTER TABLE "new_FundGoal" RENAME TO "FundGoal";
CREATE TABLE "new_Poll" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "ends_at" DATETIME,
    "total_votes_cents" INTEGER NOT NULL DEFAULT 0,
    "allow_custom_entries" BOOLEAN NOT NULL DEFAULT false,
    "max_entry_chars" INTEGER,
    "auto_approve" BOOLEAN NOT NULL DEFAULT true,
    "channel_id" TEXT,
    "event_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Poll_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Poll_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Poll" ("allow_custom_entries", "auto_approve", "channel_id", "created_at", "description", "ends_at", "id", "is_active", "max_entry_chars", "title", "total_votes_cents", "updated_at", "event_id") SELECT "old"."allow_custom_entries", "old"."auto_approve", "old"."channel_id", "old"."created_at", "old"."description", "old"."ends_at", "old"."id", "old"."is_active", "old"."max_entry_chars", "old"."title", "old"."total_votes_cents", "old"."updated_at",
  COALESCE(
    (SELECT "Channel"."event_id" FROM "Channel" WHERE "Channel"."id" = "old"."channel_id"),
    CASE WHEN (SELECT COUNT(*) FROM "Event") = 1 THEN (SELECT "id" FROM "Event") END,
    CASE WHEN (SELECT COUNT(*) FROM "_IncentiveEvent" e WHERE e."kind" = 'Poll' AND e."id" = "old"."id") = 1
      THEN (SELECT e."event_id" FROM "_IncentiveEvent" e WHERE e."kind" = 'Poll' AND e."id" = "old"."id") END
  )
FROM "Poll" AS "old";
DROP TABLE "Poll";
ALTER TABLE "new_Poll" RENAME TO "Poll";
CREATE TABLE "new_Reward" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "cost_cents" INTEGER NOT NULL,
    "quantity_total" INTEGER,
    "quantity_claimed" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "custom_type_label" TEXT,
    "image_url" TEXT,
    "channel_id" TEXT,
    "event_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Reward_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Reward_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Reward" ("channel_id", "cost_cents", "created_at", "custom_type_label", "description", "id", "image_url", "is_active", "quantity_claimed", "quantity_total", "title", "type", "updated_at", "event_id") SELECT "old"."channel_id", "old"."cost_cents", "old"."created_at", "old"."custom_type_label", "old"."description", "old"."id", "old"."image_url", "old"."is_active", "old"."quantity_claimed", "old"."quantity_total", "old"."title", "old"."type", "old"."updated_at",
  COALESCE(
    (SELECT "Channel"."event_id" FROM "Channel" WHERE "Channel"."id" = "old"."channel_id"),
    CASE WHEN (SELECT COUNT(*) FROM "Event") = 1 THEN (SELECT "id" FROM "Event") END,
    CASE WHEN (SELECT COUNT(*) FROM "_IncentiveEvent" e WHERE e."kind" = 'Reward' AND e."id" = "old"."id") = 1
      THEN (SELECT e."event_id" FROM "_IncentiveEvent" e WHERE e."kind" = 'Reward' AND e."id" = "old"."id") END
  )
FROM "Reward" AS "old";
DROP TABLE "Reward";
ALTER TABLE "new_Reward" RENAME TO "Reward";

-- ADR-0012 invariant in the database: a Channel incentive belongs to its Channel's
-- Event, and a Channel that owns incentives keeps its Event. Prisma does not model
-- triggers; a later table rebuild of these tables must recreate them.
CREATE TRIGGER "Reward_event_matches_channel_insert"
BEFORE INSERT ON "Reward"
WHEN NEW."channel_id" IS NOT NULL
  AND NEW."event_id" IS NOT (SELECT "event_id" FROM "Channel" WHERE "id" = NEW."channel_id")
BEGIN
  SELECT RAISE(ABORT, 'event_id must be the Event of channel_id');
END;
CREATE TRIGGER "Reward_event_matches_channel_update"
BEFORE UPDATE OF "channel_id", "event_id" ON "Reward"
WHEN NEW."channel_id" IS NOT NULL
  AND NEW."event_id" IS NOT (SELECT "event_id" FROM "Channel" WHERE "id" = NEW."channel_id")
BEGIN
  SELECT RAISE(ABORT, 'event_id must be the Event of channel_id');
END;
CREATE TRIGGER "Poll_event_matches_channel_insert"
BEFORE INSERT ON "Poll"
WHEN NEW."channel_id" IS NOT NULL
  AND NEW."event_id" IS NOT (SELECT "event_id" FROM "Channel" WHERE "id" = NEW."channel_id")
BEGIN
  SELECT RAISE(ABORT, 'event_id must be the Event of channel_id');
END;
CREATE TRIGGER "Poll_event_matches_channel_update"
BEFORE UPDATE OF "channel_id", "event_id" ON "Poll"
WHEN NEW."channel_id" IS NOT NULL
  AND NEW."event_id" IS NOT (SELECT "event_id" FROM "Channel" WHERE "id" = NEW."channel_id")
BEGIN
  SELECT RAISE(ABORT, 'event_id must be the Event of channel_id');
END;
CREATE TRIGGER "FundGoal_event_matches_channel_insert"
BEFORE INSERT ON "FundGoal"
WHEN NEW."channel_id" IS NOT NULL
  AND NEW."event_id" IS NOT (SELECT "event_id" FROM "Channel" WHERE "id" = NEW."channel_id")
BEGIN
  SELECT RAISE(ABORT, 'event_id must be the Event of channel_id');
END;
CREATE TRIGGER "FundGoal_event_matches_channel_update"
BEFORE UPDATE OF "channel_id", "event_id" ON "FundGoal"
WHEN NEW."channel_id" IS NOT NULL
  AND NEW."event_id" IS NOT (SELECT "event_id" FROM "Channel" WHERE "id" = NEW."channel_id")
BEGIN
  SELECT RAISE(ABORT, 'event_id must be the Event of channel_id');
END;
CREATE TRIGGER "Auction_event_matches_channel_insert"
BEFORE INSERT ON "Auction"
WHEN NEW."channel_id" IS NOT NULL
  AND NEW."event_id" IS NOT (SELECT "event_id" FROM "Channel" WHERE "id" = NEW."channel_id")
BEGIN
  SELECT RAISE(ABORT, 'event_id must be the Event of channel_id');
END;
CREATE TRIGGER "Auction_event_matches_channel_update"
BEFORE UPDATE OF "channel_id", "event_id" ON "Auction"
WHEN NEW."channel_id" IS NOT NULL
  AND NEW."event_id" IS NOT (SELECT "event_id" FROM "Channel" WHERE "id" = NEW."channel_id")
BEGIN
  SELECT RAISE(ABORT, 'event_id must be the Event of channel_id');
END;
CREATE TRIGGER "Channel_keeps_event_with_incentives"
BEFORE UPDATE OF "event_id" ON "Channel"
WHEN NEW."event_id" IS NOT OLD."event_id" AND (
  EXISTS (SELECT 1 FROM "Reward" WHERE "channel_id" = OLD."id") OR
  EXISTS (SELECT 1 FROM "Poll" WHERE "channel_id" = OLD."id") OR
  EXISTS (SELECT 1 FROM "FundGoal" WHERE "channel_id" = OLD."id") OR
  EXISTS (SELECT 1 FROM "Auction" WHERE "channel_id" = OLD."id")
)
BEGIN
  SELECT RAISE(ABORT, 'A Channel with incentives cannot move to another Event');
END;

DROP TABLE "_IncentiveEvent";

COMMIT;
PRAGMA foreign_keys=ON;
