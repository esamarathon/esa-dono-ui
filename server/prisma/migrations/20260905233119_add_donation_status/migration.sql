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
    "channel_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "refund_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Donation_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Donation_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Donation_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "BalanceAdjustment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Donation" ("amount_cents", "channel_id", "comment", "created_at", "donor_id", "donor_name", "external_id", "id", "moderated", "moderated_at", "moderated_by") SELECT "amount_cents", "channel_id", "comment", "created_at", "donor_id", "donor_name", "external_id", "id", "moderated", "moderated_at", "moderated_by" FROM "Donation";
DROP TABLE "Donation";
ALTER TABLE "new_Donation" RENAME TO "Donation";
CREATE UNIQUE INDEX "Donation_external_id_key" ON "Donation"("external_id");
CREATE UNIQUE INDEX "Donation_refund_id_key" ON "Donation"("refund_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
