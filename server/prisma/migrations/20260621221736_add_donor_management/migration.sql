-- AlterTable
ALTER TABLE "FundContribution" ADD COLUMN "reversed_at" DATETIME;
ALTER TABLE "FundContribution" ADD COLUMN "reversed_by" TEXT;

-- AlterTable
ALTER TABLE "PollVote" ADD COLUMN "reversed_at" DATETIME;
ALTER TABLE "PollVote" ADD COLUMN "reversed_by" TEXT;

-- AlterTable
ALTER TABLE "RewardClaim" ADD COLUMN "reversed_at" DATETIME;
ALTER TABLE "RewardClaim" ADD COLUMN "reversed_by" TEXT;

-- CreateTable
CREATE TABLE "BalanceAdjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "balance_after_cents" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT,
    "reference_id" TEXT,
    "created_by" TEXT NOT NULL DEFAULT 'admin',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BalanceAdjustment_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

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
    "is_moderator" BOOLEAN NOT NULL DEFAULT false,
    "is_frozen" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_Donor" ("balance_remaining", "created_at", "email", "id", "is_moderator", "magic_token", "token_expires_at", "total_donated", "updated_at") SELECT "balance_remaining", "created_at", "email", "id", "is_moderator", "magic_token", "token_expires_at", "total_donated", "updated_at" FROM "Donor";
DROP TABLE "Donor";
ALTER TABLE "new_Donor" RENAME TO "Donor";
CREATE UNIQUE INDEX "Donor_email_key" ON "Donor"("email");
CREATE UNIQUE INDEX "Donor_magic_token_key" ON "Donor"("magic_token");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
