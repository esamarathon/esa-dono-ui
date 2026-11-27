-- CreateTable
CREATE TABLE "Stream" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "stream_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Donation_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Donation_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "Stream" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Donation" ("amount_cents", "comment", "created_at", "donor_id", "donor_name", "external_id", "id", "moderated", "moderated_at", "moderated_by") SELECT "amount_cents", "comment", "created_at", "donor_id", "donor_name", "external_id", "id", "moderated", "moderated_at", "moderated_by" FROM "Donation";
DROP TABLE "Donation";
ALTER TABLE "new_Donation" RENAME TO "Donation";
CREATE UNIQUE INDEX "Donation_external_id_key" ON "Donation"("external_id");
CREATE TABLE "new_FundGoal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "target_cents" INTEGER NOT NULL,
    "current_cents" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_complete" BOOLEAN NOT NULL DEFAULT false,
    "stream_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "FundGoal_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "Stream" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_FundGoal" ("created_at", "current_cents", "description", "id", "is_active", "is_complete", "target_cents", "title", "updated_at") SELECT "created_at", "current_cents", "description", "id", "is_active", "is_complete", "target_cents", "title", "updated_at" FROM "FundGoal";
DROP TABLE "FundGoal";
ALTER TABLE "new_FundGoal" RENAME TO "FundGoal";
CREATE TABLE "new_PendingPledge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pledge_token" TEXT NOT NULL,
    "donor_email" TEXT,
    "total_cents" INTEGER NOT NULL,
    "top_up_cents" INTEGER NOT NULL DEFAULT 0,
    "wallet_discount_cents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "requires_shipping" BOOLEAN NOT NULL DEFAULT false,
    "checkout_session_id" TEXT,
    "checkout_url" TEXT,
    "comment" TEXT,
    "stream_id" TEXT,
    "fulfilled_by_donation_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "PendingPledge_fulfilled_by_donation_id_fkey" FOREIGN KEY ("fulfilled_by_donation_id") REFERENCES "Donation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PendingPledge_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "Stream" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PendingPledge" ("checkout_session_id", "checkout_url", "comment", "created_at", "donor_email", "expires_at", "fulfilled_by_donation_id", "id", "pledge_token", "requires_shipping", "status", "top_up_cents", "total_cents", "updated_at", "wallet_discount_cents") SELECT "checkout_session_id", "checkout_url", "comment", "created_at", "donor_email", "expires_at", "fulfilled_by_donation_id", "id", "pledge_token", "requires_shipping", "status", "top_up_cents", "total_cents", "updated_at", "wallet_discount_cents" FROM "PendingPledge";
DROP TABLE "PendingPledge";
ALTER TABLE "new_PendingPledge" RENAME TO "PendingPledge";
CREATE UNIQUE INDEX "PendingPledge_pledge_token_key" ON "PendingPledge"("pledge_token");
CREATE UNIQUE INDEX "PendingPledge_fulfilled_by_donation_id_key" ON "PendingPledge"("fulfilled_by_donation_id");
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
    "stream_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Poll_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "Stream" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Poll" ("allow_custom_entries", "auto_approve", "created_at", "description", "ends_at", "id", "is_active", "max_entry_chars", "title", "total_votes_cents", "updated_at") SELECT "allow_custom_entries", "auto_approve", "created_at", "description", "ends_at", "id", "is_active", "max_entry_chars", "title", "total_votes_cents", "updated_at" FROM "Poll";
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
    "stream_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Reward_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "Stream" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Reward" ("cost_cents", "created_at", "custom_type_label", "description", "id", "is_active", "quantity_claimed", "quantity_total", "title", "type", "updated_at") SELECT "cost_cents", "created_at", "custom_type_label", "description", "id", "is_active", "quantity_claimed", "quantity_total", "title", "type", "updated_at" FROM "Reward";
DROP TABLE "Reward";
ALTER TABLE "new_Reward" RENAME TO "Reward";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Stream_name_key" ON "Stream"("name");
