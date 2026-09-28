-- #114 / PRD-0002 §S: Event (parent of Channel), Channel.slug + Channel.event_id,
-- Donation.event_id + hidden_from_overlay, WebhookEndpoint.payload_format,
-- WebhookDelivery.routing_key. Ids switch from cuid to uuid at the Prisma level
-- (no SQL change; new rows only).
--
-- Hand-edited so it also applies to a database that already has channels:
-- - a default Event (fixed id, inactive, no primary channel) is inserted and every
--   existing Channel is attached to it;
-- - existing Channels get slug 'channel-<their id without dashes>', which is valid
--   under lib/slugs.ts and unique. Rename them (while inactive) in the admin UI;
-- - existing Donations with a channel get that default Event.
-- Staging and dev are expected to be reset (PRD-0002 §S1); this only keeps
-- `migrate deploy` from failing on a non-empty database.

-- AlterTable
ALTER TABLE "WebhookDelivery" ADD COLUMN "routing_key" TEXT;

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "primary_channel_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Event_primary_channel_id_fkey" FOREIGN KEY ("primary_channel_id") REFERENCES "Channel" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Default Event for existing (and seeded) Channels.
INSERT INTO "Event" ("id", "name", "slug", "is_active", "created_at", "updated_at")
VALUES ('00000000-0000-4000-8000-000000000001', 'Default Event', 'default-event', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Channel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Channel_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Channel" ("created_at", "event_id", "id", "is_active", "name", "slug", "updated_at") SELECT "created_at", '00000000-0000-4000-8000-000000000001', "id", "is_active", "name", 'channel-' || replace(lower("id"), '-', ''), "updated_at" FROM "Channel";
DROP TABLE "Channel";
ALTER TABLE "new_Channel" RENAME TO "Channel";
CREATE UNIQUE INDEX "Channel_name_key" ON "Channel"("name");
CREATE UNIQUE INDEX "Channel_slug_key" ON "Channel"("slug");
CREATE TABLE "new_Donation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "external_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "donor_name" TEXT,
    "comment" TEXT,
    "moderated" BOOLEAN NOT NULL DEFAULT false,
    "moderated_at" DATETIME,
    "moderated_by" TEXT,
    "channel_id" TEXT,
    "event_id" TEXT,
    "hidden_from_overlay" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "refund_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Donation_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Donation_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Donation_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Donation_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "BalanceAdjustment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Donation" ("amount_cents", "channel_id", "comment", "created_at", "donor_id", "donor_name", "event_id", "external_id", "id", "moderated", "moderated_at", "moderated_by", "refund_id", "status") SELECT "amount_cents", "channel_id", "comment", "created_at", "donor_id", "donor_name", CASE WHEN "channel_id" IS NULL THEN NULL ELSE '00000000-0000-4000-8000-000000000001' END, "external_id", "id", "moderated", "moderated_at", "moderated_by", "refund_id", "status" FROM "Donation";
DROP TABLE "Donation";
ALTER TABLE "new_Donation" RENAME TO "Donation";
CREATE UNIQUE INDEX "Donation_external_id_key" ON "Donation"("external_id");
CREATE UNIQUE INDEX "Donation_refund_id_key" ON "Donation"("refund_id");
CREATE TABLE "new_WebhookEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "event_types" TEXT NOT NULL DEFAULT '[]',
    "verify_ssl" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "destination_type" TEXT NOT NULL DEFAULT 'HTTP',
    "amqp_url" TEXT,
    "amqp_exchange" TEXT NOT NULL DEFAULT '',
    "amqp_routing_key" TEXT,
    "payload_format" TEXT NOT NULL DEFAULT 'NATIVE'
);
INSERT INTO "new_WebhookEndpoint" ("amqp_exchange", "amqp_routing_key", "amqp_url", "created_at", "description", "destination_type", "event_types", "id", "is_active", "secret", "updated_at", "url", "verify_ssl") SELECT "amqp_exchange", "amqp_routing_key", "amqp_url", "created_at", "description", "destination_type", "event_types", "id", "is_active", "secret", "updated_at", "url", "verify_ssl" FROM "WebhookEndpoint";
DROP TABLE "WebhookEndpoint";
ALTER TABLE "new_WebhookEndpoint" RENAME TO "WebhookEndpoint";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Event_primary_channel_id_key" ON "Event"("primary_channel_id");
