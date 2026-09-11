-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PledgeItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pledge_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "poll_id" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "data" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PledgeItem_pledge_id_fkey" FOREIGN KEY ("pledge_id") REFERENCES "PendingPledge" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PledgeItem" ("amount_cents", "created_at", "data", "id", "kind", "pledge_id", "poll_id", "target_id") SELECT "amount_cents", "created_at", "data", "id", "kind", "pledge_id", "poll_id", "target_id" FROM "PledgeItem";
DROP TABLE "PledgeItem";
ALTER TABLE "new_PledgeItem" RENAME TO "PledgeItem";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
