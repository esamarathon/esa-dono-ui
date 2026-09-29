-- #116 / PRD-0002 §T4: link RewardClaim to the donation whose pledge created it,
-- so the Tiltify donation message can list its reward_claims. Nullable: claims
-- made directly from the wallet belong to no donation. Existing rows keep null.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RewardClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reward_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "claim_data" TEXT,
    "donation_id" TEXT,
    "reversed_at" DATETIME,
    "reversed_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "RewardClaim_reward_id_fkey" FOREIGN KEY ("reward_id") REFERENCES "Reward" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RewardClaim_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RewardClaim_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_RewardClaim" ("claim_data", "created_at", "donor_id", "id", "reversed_at", "reversed_by", "reward_id", "status", "updated_at") SELECT "claim_data", "created_at", "donor_id", "id", "reversed_at", "reversed_by", "reward_id", "status", "updated_at" FROM "RewardClaim";
DROP TABLE "RewardClaim";
ALTER TABLE "new_RewardClaim" RENAME TO "RewardClaim";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
