-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PendingPledge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pledge_token" TEXT NOT NULL,
    "donor_email" TEXT,
    "total_cents" INTEGER NOT NULL,
    "top_up_cents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "checkout_session_id" TEXT,
    "checkout_url" TEXT,
    "comment" TEXT,
    "fulfilled_by_donation_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "PendingPledge_fulfilled_by_donation_id_fkey" FOREIGN KEY ("fulfilled_by_donation_id") REFERENCES "Donation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PendingPledge" ("checkout_session_id", "checkout_url", "comment", "created_at", "donor_email", "expires_at", "fulfilled_by_donation_id", "id", "pledge_token", "status", "total_cents", "updated_at") SELECT "checkout_session_id", "checkout_url", "comment", "created_at", "donor_email", "expires_at", "fulfilled_by_donation_id", "id", "pledge_token", "status", "total_cents", "updated_at" FROM "PendingPledge";
DROP TABLE "PendingPledge";
ALTER TABLE "new_PendingPledge" RENAME TO "PendingPledge";
CREATE UNIQUE INDEX "PendingPledge_pledge_token_key" ON "PendingPledge"("pledge_token");
CREATE UNIQUE INDEX "PendingPledge_fulfilled_by_donation_id_key" ON "PendingPledge"("fulfilled_by_donation_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
