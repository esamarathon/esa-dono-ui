-- Atomic schema/backfills; foreign keys must be disabled before SQLite rebuilds.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN "end_undone_at" DATETIME;
ALTER TABLE "Event" ADD COLUMN "end_undone_by" TEXT;
ALTER TABLE "Event" ADD COLUMN "ended_at" DATETIME;
ALTER TABLE "Event" ADD COLUMN "ended_by" TEXT;

-- CreateTable
CREATE TABLE "PoolCredit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "donation_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "remaining_cents" INTEGER NOT NULL,
    "source_claim_id" TEXT,
    "source_vote_id" TEXT,
    "source_contribution_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleared_at" DATETIME,
    "cleared_by" TEXT,
    CONSTRAINT "PoolCredit_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PoolCredit_source_claim_id_fkey" FOREIGN KEY ("source_claim_id") REFERENCES "RewardClaim" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PoolCredit_source_vote_id_fkey" FOREIGN KEY ("source_vote_id") REFERENCES "PollVote" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PoolCredit_source_contribution_id_fkey" FOREIGN KEY ("source_contribution_id") REFERENCES "FundContribution" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PoolCredit_amount_check" CHECK ("amount_cents" > 0 AND "remaining_cents" >= 0 AND "remaining_cents" <= "amount_cents"),
    CONSTRAINT "PoolCredit_origin_check" CHECK (
      ("category" = 'reward' AND "source_claim_id" IS NOT NULL AND "source_vote_id" IS NULL AND "source_contribution_id" IS NULL) OR
      ("category" = 'poll' AND "source_vote_id" IS NOT NULL AND "source_claim_id" IS NULL AND "source_contribution_id" IS NULL) OR
      ("category" = 'goal' AND "source_contribution_id" IS NOT NULL AND "source_claim_id" IS NULL AND "source_vote_id" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "PoolCreditBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "donor_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_data" TEXT NOT NULL,
    "result_data" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PoolCreditBatch_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PoolCreditBatch_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PoolCreditRedemption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "credit_id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "claim_id" TEXT,
    "vote_id" TEXT,
    "contribution_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PoolCreditRedemption_credit_id_fkey" FOREIGN KEY ("credit_id") REFERENCES "PoolCredit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PoolCreditRedemption_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "PoolCreditBatch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PoolCreditRedemption_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "RewardClaim" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PoolCreditRedemption_vote_id_fkey" FOREIGN KEY ("vote_id") REFERENCES "PollVote" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PoolCreditRedemption_contribution_id_fkey" FOREIGN KEY ("contribution_id") REFERENCES "FundContribution" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PoolCreditRedemption_target_check" CHECK (
      "amount_cents" > 0 AND (("claim_id" IS NOT NULL) + ("vote_id" IS NOT NULL) + ("contribution_id" IS NOT NULL)) = 1
    )
);

-- CreateTable
CREATE TABLE "EventEndAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "event_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EventEndAudit_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaymentRefund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "donation_id" TEXT NOT NULL,
    "claim_id" TEXT NOT NULL,
    "item_cents" INTEGER NOT NULL,
    "shipping_cents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "stripe_refund_id" TEXT,
    "pool_shrink_data" TEXT,
    "failure_reason" TEXT,
    "resolution" TEXT,
    "shipping_resolution" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "accepted_at" DATETIME,
    "resolved_at" DATETIME,
    "resolved_by" TEXT,
    "shipping_resolved_at" DATETIME,
    "shipping_resolved_by" TEXT,
    CONSTRAINT "PaymentRefund_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PaymentRefund_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "RewardClaim" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChannelDefaultGoal" (
    "channel_id" TEXT NOT NULL,
    "goal_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    PRIMARY KEY ("channel_id", "goal_id"),
    CONSTRAINT "ChannelDefaultGoal_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChannelDefaultGoal_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "FundGoal" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
CREATE TABLE "new_BalanceAdjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "balance_after_cents" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT,
    "reference_id" TEXT,
    "created_by" TEXT NOT NULL DEFAULT 'admin',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "donation_id" TEXT,
    "payment_refund_id" TEXT,
    "idempotency_key" TEXT,
    CONSTRAINT "BalanceAdjustment_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BalanceAdjustment_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BalanceAdjustment_payment_refund_id_fkey" FOREIGN KEY ("payment_refund_id") REFERENCES "PaymentRefund" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_BalanceAdjustment" ("amount_cents", "balance_after_cents", "created_at", "created_by", "donor_id", "id", "reason", "reference_id", "type") SELECT "amount_cents", "balance_after_cents", "created_at", "created_by", "donor_id", "id", "reason", "reference_id", "type" FROM "BalanceAdjustment";
DROP TABLE "BalanceAdjustment";
ALTER TABLE "new_BalanceAdjustment" RENAME TO "BalanceAdjustment";
CREATE UNIQUE INDEX "BalanceAdjustment_payment_refund_id_key" ON "BalanceAdjustment"("payment_refund_id");
CREATE UNIQUE INDEX "BalanceAdjustment_idempotency_key_key" ON "BalanceAdjustment"("idempotency_key");
CREATE INDEX "BalanceAdjustment_donation_id_idx" ON "BalanceAdjustment"("donation_id");
CREATE TABLE "new_Donation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "external_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "pledge_amount_cents" INTEGER,
    "wallet_applied_cents" INTEGER NOT NULL DEFAULT 0,
    "wallet_credit_granted_cents" INTEGER NOT NULL DEFAULT 0,
    "failed_payment_wallet_credit_cents" INTEGER NOT NULL DEFAULT 0,
    "shipping_cents" INTEGER,
    "shipping_refunded_cents" INTEGER NOT NULL DEFAULT 0,
    "shipping_recorded_at" DATETIME,
    "payment_intent" TEXT,
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
INSERT INTO "new_Donation" ("amount_cents", "channel_id", "comment", "created_at", "donor_id", "donor_name", "event_id", "external_id", "hidden_from_overlay", "id", "moderated", "moderated_at", "moderated_by", "refund_id", "status") SELECT "amount_cents", "channel_id", "comment", "created_at", "donor_id", "donor_name", "event_id", "external_id", "hidden_from_overlay", "id", "moderated", "moderated_at", "moderated_by", "refund_id", "status" FROM "Donation";
DROP TABLE "Donation";
ALTER TABLE "new_Donation" RENAME TO "Donation";
CREATE UNIQUE INDEX "Donation_external_id_key" ON "Donation"("external_id");
CREATE UNIQUE INDEX "Donation_refund_id_key" ON "Donation"("refund_id");
CREATE TABLE "new_Donor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "total_donated" INTEGER NOT NULL DEFAULT 0,
    "balance_remaining" INTEGER NOT NULL DEFAULT 0,
    "balance_held_cents" INTEGER NOT NULL DEFAULT 0,
    "magic_token" TEXT,
    "token_expires_at" DATETIME,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_frozen" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_Donor" ("balance_remaining", "created_at", "email", "email_verified", "id", "is_frozen", "magic_token", "role", "token_expires_at", "total_donated", "updated_at") SELECT "balance_remaining", "created_at", "email", "email_verified", "id", "is_frozen", "magic_token", "role", "token_expires_at", "total_donated", "updated_at" FROM "Donor";
DROP TABLE "Donor";
ALTER TABLE "new_Donor" RENAME TO "Donor";
CREATE UNIQUE INDEX "Donor_email_key" ON "Donor"("email");
CREATE UNIQUE INDEX "Donor_magic_token_key" ON "Donor"("magic_token");
CREATE TABLE "new_FundContribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "goal_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'donor',
    "allocated_by" TEXT,
    "allocated_at" DATETIME,
    "donation_id" TEXT,
    "reversed_at" DATETIME,
    "reversed_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FundContribution_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "FundGoal" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FundContribution_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FundContribution_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FundContribution_source_check" CHECK ("source" IN ('donor', 'auto', 'moderator') AND
      ("source" <> 'moderator' OR ("allocated_by" IS NOT NULL AND "allocated_at" IS NOT NULL)))
);
INSERT INTO "new_FundContribution" ("amount_cents", "created_at", "donation_id", "donor_id", "goal_id", "id", "reversed_at", "reversed_by") SELECT "amount_cents", "created_at", "donation_id", "donor_id", "goal_id", "id", "reversed_at", "reversed_by" FROM "FundContribution";
DROP TABLE "FundContribution";
ALTER TABLE "new_FundContribution" RENAME TO "FundContribution";
CREATE TABLE "new_PendingPledge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pledge_token" TEXT NOT NULL,
    "donor_email" TEXT,
    "format" TEXT NOT NULL DEFAULT 'LEGACY',
    "pledge_amount_cents" INTEGER,
    "draft_id" TEXT,
    "confirmed_plan" TEXT,
    "new_money_cents" INTEGER,
    "held_wallet_cents" INTEGER NOT NULL DEFAULT 0,
    "wallet_donor_id" TEXT,
    "wallet_hold_status" TEXT NOT NULL DEFAULT 'NONE',
    "wallet_consumed_at" DATETIME,
    "wallet_released_at" DATETIME,
    "non_payment_confirmed_at" DATETIME,
    "payment_status" TEXT,
    "checkout_session_status" TEXT,
    "reconciled_at" DATETIME,
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "top_up_cents" INTEGER NOT NULL DEFAULT 0,
    "wallet_discount_cents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "requires_shipping" BOOLEAN NOT NULL DEFAULT false,
    "checkout_session_id" TEXT,
    "checkout_url" TEXT,
    "comment" TEXT,
    "display_name" TEXT,
    "channel_id" TEXT,
    "fulfilled_by_donation_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "PendingPledge_fulfilled_by_donation_id_fkey" FOREIGN KEY ("fulfilled_by_donation_id") REFERENCES "Donation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PendingPledge_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PendingPledge_wallet_donor_id_fkey" FOREIGN KEY ("wallet_donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- New and old shapes cannot accidentally select the other's accounting rule.
    CONSTRAINT "PendingPledge_format_check" CHECK (
      ("format" = 'LEGACY' AND "pledge_amount_cents" IS NULL) OR
      ("format" = 'POOLED' AND "pledge_amount_cents" IS NOT NULL AND "pledge_amount_cents" >= 0 AND
       "draft_id" IS NOT NULL AND "confirmed_plan" IS NOT NULL AND "new_money_cents" IS NOT NULL AND
       "new_money_cents" >= 0 AND "pledge_amount_cents" = "new_money_cents" + "held_wallet_cents" AND
       "total_cents" = 0 AND "top_up_cents" = 0 AND "wallet_discount_cents" = 0)
    ),
    CONSTRAINT "PendingPledge_hold_check" CHECK (
      ("held_wallet_cents" = 0 AND "wallet_hold_status" = 'NONE') OR
      ("held_wallet_cents" > 0 AND "wallet_donor_id" IS NOT NULL AND "wallet_hold_status" IN ('HELD', 'CONSUMED', 'RELEASED'))
    )
);
INSERT INTO "new_PendingPledge" ("channel_id", "checkout_session_id", "checkout_url", "comment", "created_at", "display_name", "donor_email", "expires_at", "fulfilled_by_donation_id", "id", "pledge_token", "requires_shipping", "status", "top_up_cents", "total_cents", "updated_at", "wallet_discount_cents") SELECT "channel_id", "checkout_session_id", "checkout_url", "comment", "created_at", "display_name", "donor_email", "expires_at", "fulfilled_by_donation_id", "id", "pledge_token", "requires_shipping", "status", "top_up_cents", "total_cents", "updated_at", "wallet_discount_cents" FROM "PendingPledge";
DROP TABLE "PendingPledge";
ALTER TABLE "new_PendingPledge" RENAME TO "PendingPledge";
CREATE UNIQUE INDEX "PendingPledge_pledge_token_key" ON "PendingPledge"("pledge_token");
CREATE UNIQUE INDEX "PendingPledge_fulfilled_by_donation_id_key" ON "PendingPledge"("fulfilled_by_donation_id");
CREATE INDEX "PendingPledge_draft_id_idx" ON "PendingPledge"("draft_id");
CREATE INDEX "PendingPledge_wallet_donor_id_wallet_hold_status_idx" ON "PendingPledge"("wallet_donor_id", "wallet_hold_status");
CREATE TABLE "new_PledgeItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pledge_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "poll_id" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "unit_price_cents" INTEGER,
    "confirmed_reward_type" TEXT,
    "source" TEXT NOT NULL DEFAULT 'donor',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "data" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PledgeItem_pledge_id_fkey" FOREIGN KEY ("pledge_id") REFERENCES "PendingPledge" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PledgeItem" ("amount_cents", "created_at", "data", "id", "kind", "pledge_id", "poll_id", "quantity", "target_id") SELECT "amount_cents", "created_at", "data", "id", "kind", "pledge_id", "poll_id", "quantity", "target_id" FROM "PledgeItem";
DROP TABLE "PledgeItem";
ALTER TABLE "new_PledgeItem" RENAME TO "PledgeItem";
CREATE TABLE "new_PollVote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poll_id" TEXT NOT NULL,
    "poll_option_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'donor',
    "allocated_by" TEXT,
    "allocated_at" DATETIME,
    "donation_id" TEXT,
    "reversed_at" DATETIME,
    "reversed_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PollVote_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "Poll" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PollVote_poll_option_id_fkey" FOREIGN KEY ("poll_option_id") REFERENCES "PollOption" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PollVote_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PollVote_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PollVote_source_check" CHECK ("source" IN ('donor', 'auto', 'moderator') AND
      ("source" <> 'moderator' OR ("allocated_by" IS NOT NULL AND "allocated_at" IS NOT NULL)))
);
INSERT INTO "new_PollVote" ("amount_cents", "created_at", "donation_id", "donor_id", "id", "poll_id", "poll_option_id", "reversed_at", "reversed_by") SELECT "amount_cents", "created_at", "donation_id", "donor_id", "id", "poll_id", "poll_option_id", "reversed_at", "reversed_by" FROM "PollVote";
DROP TABLE "PollVote";
ALTER TABLE "new_PollVote" RENAME TO "PollVote";
CREATE TABLE "new_RewardClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reward_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "amount_cents" INTEGER NOT NULL DEFAULT 0,
    "claim_data" TEXT,
    "donation_id" TEXT,
    "reversed_at" DATETIME,
    "reversed_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "chargeback_flagged_at" DATETIME,
    "chargeback_acknowledged_at" DATETIME,
    "chargeback_acknowledged_by" TEXT,
    "chargeback_acknowledgement_note" TEXT,
    CONSTRAINT "RewardClaim_reward_id_fkey" FOREIGN KEY ("reward_id") REFERENCES "Reward" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RewardClaim_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RewardClaim_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_RewardClaim" ("claim_data", "created_at", "donation_id", "donor_id", "id", "reversed_at", "reversed_by", "reward_id", "status", "updated_at") SELECT "claim_data", "created_at", "donation_id", "donor_id", "id", "reversed_at", "reversed_by", "reward_id", "status", "updated_at" FROM "RewardClaim";
DROP TABLE "RewardClaim";
ALTER TABLE "new_RewardClaim" RENAME TO "RewardClaim";

-- CreateIndex
CREATE UNIQUE INDEX "PoolCredit_source_claim_id_key" ON "PoolCredit"("source_claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "PoolCredit_source_vote_id_key" ON "PoolCredit"("source_vote_id");

-- CreateIndex
CREATE UNIQUE INDEX "PoolCredit_source_contribution_id_key" ON "PoolCredit"("source_contribution_id");

-- CreateIndex
CREATE INDEX "PoolCredit_donation_id_category_idx" ON "PoolCredit"("donation_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "PoolCreditBatch_donor_id_idempotency_key_key" ON "PoolCreditBatch"("donor_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "PoolCreditRedemption_credit_id_idx" ON "PoolCreditRedemption"("credit_id");

-- CreateIndex
CREATE INDEX "PoolCreditRedemption_batch_id_idx" ON "PoolCreditRedemption"("batch_id");

-- CreateIndex
CREATE INDEX "PoolCreditRedemption_claim_id_idx" ON "PoolCreditRedemption"("claim_id");

-- CreateIndex
CREATE INDEX "PoolCreditRedemption_vote_id_idx" ON "PoolCreditRedemption"("vote_id");

-- CreateIndex
CREATE INDEX "PoolCreditRedemption_contribution_id_idx" ON "PoolCreditRedemption"("contribution_id");

-- CreateIndex
CREATE INDEX "EventEndAudit_event_id_created_at_idx" ON "EventEndAudit"("event_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRefund_stripe_refund_id_key" ON "PaymentRefund"("stripe_refund_id");

-- CreateIndex
CREATE INDEX "PaymentRefund_donation_id_status_idx" ON "PaymentRefund"("donation_id", "status");

-- CreateIndex
CREATE INDEX "PaymentRefund_claim_id_idx" ON "PaymentRefund"("claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelDefaultGoal_channel_id_position_key" ON "ChannelDefaultGoal"("channel_id", "position");

-- Partial indexes are not expressible in Prisma 5's schema.
CREATE UNIQUE INDEX "PendingPledge_open_draft_key" ON "PendingPledge"("draft_id") WHERE "status" = 'OPEN' AND "draft_id" IS NOT NULL;
CREATE UNIQUE INDEX "PaymentRefund_requested_donation_key" ON "PaymentRefund"("donation_id") WHERE "status" = 'REQUESTED';

-- Null donation pledge amounts select legacy accounting. Do not infer pooled budgets.
-- Only the literal wallet- prefix plus an exact 8-4-4-4-12 hexadecimal UUID is wallet-only.
UPDATE "Donation" SET "amount_cents" = 0 WHERE "external_id" GLOB (
  'wallet-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]' ||
  '-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]' ||
  '-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]' ||
  '-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]' ||
  '-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]'
);
UPDATE "PendingPledge"
SET "status" = 'EXPIRED', "updated_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "format" = 'LEGACY' AND "status" = 'OPEN';
-- Missing reward history fails the transaction, including preceding money corrections.
UPDATE "RewardClaim"
SET "amount_cents" = (SELECT "cost_cents" FROM "Reward" WHERE "Reward"."id" = "RewardClaim"."reward_id");

COMMIT;
PRAGMA foreign_keys=ON;
