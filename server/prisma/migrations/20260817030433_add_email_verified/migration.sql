-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Donor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "total_donated" INTEGER NOT NULL DEFAULT 0,
    "balance_remaining" INTEGER NOT NULL DEFAULT 0,
    "magic_token" TEXT,
    "token_expires_at" DATETIME,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_frozen" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_Donor" ("balance_remaining", "created_at", "email", "id", "is_frozen", "magic_token", "role", "token_expires_at", "total_donated", "updated_at") SELECT "balance_remaining", "created_at", "email", "id", "is_frozen", "magic_token", "role", "token_expires_at", "total_donated", "updated_at" FROM "Donor";
DROP TABLE "Donor";
ALTER TABLE "new_Donor" RENAME TO "Donor";
CREATE UNIQUE INDEX "Donor_email_key" ON "Donor"("email");
CREATE UNIQUE INDEX "Donor_magic_token_key" ON "Donor"("magic_token");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- RedefineIndex
DROP INDEX "Stream_name_key";
CREATE UNIQUE INDEX "Event_name_key" ON "Event"("name");
