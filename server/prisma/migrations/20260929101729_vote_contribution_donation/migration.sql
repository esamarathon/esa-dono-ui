-- #116 / PRD-0002 §T4: link PollVote and FundContribution to the donation whose
-- pledge paid for them, so the Tiltify donation lists only what was actually
-- fulfilled (a pledge item can be skipped). Nullable: wallet spends belong to no
-- donation. Existing rows keep null.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FundContribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "goal_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "donation_id" TEXT,
    "reversed_at" DATETIME,
    "reversed_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FundContribution_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "FundGoal" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FundContribution_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FundContribution_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_FundContribution" ("amount_cents", "created_at", "donor_id", "goal_id", "id", "reversed_at", "reversed_by") SELECT "amount_cents", "created_at", "donor_id", "goal_id", "id", "reversed_at", "reversed_by" FROM "FundContribution";
DROP TABLE "FundContribution";
ALTER TABLE "new_FundContribution" RENAME TO "FundContribution";
CREATE TABLE "new_PollVote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poll_id" TEXT NOT NULL,
    "poll_option_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "donation_id" TEXT,
    "reversed_at" DATETIME,
    "reversed_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PollVote_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "Poll" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PollVote_poll_option_id_fkey" FOREIGN KEY ("poll_option_id") REFERENCES "PollOption" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PollVote_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PollVote_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PollVote" ("amount_cents", "created_at", "donor_id", "id", "poll_id", "poll_option_id", "reversed_at", "reversed_by") SELECT "amount_cents", "created_at", "donor_id", "id", "poll_id", "poll_option_id", "reversed_at", "reversed_by" FROM "PollVote";
DROP TABLE "PollVote";
ALTER TABLE "new_PollVote" RENAME TO "PollVote";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
