BEGIN;

-- CreateTable
CREATE TABLE "Donor" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "total_donated" INTEGER NOT NULL DEFAULT 0,
    "balance_remaining" INTEGER NOT NULL DEFAULT 0,
    "balance_held_cents" INTEGER NOT NULL DEFAULT 0,
    "magic_token" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "role" TEXT NOT NULL DEFAULT 'USER',
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_frozen" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Donor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Donation" (
    "id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "pledge_amount_cents" INTEGER,
    "wallet_applied_cents" INTEGER NOT NULL DEFAULT 0,
    "wallet_credit_granted_cents" INTEGER NOT NULL DEFAULT 0,
    "failed_payment_wallet_credit_cents" INTEGER NOT NULL DEFAULT 0,
    "shipping_cents" INTEGER,
    "shipping_refunded_cents" INTEGER NOT NULL DEFAULT 0,
    "shipping_recorded_at" TIMESTAMP(3),
    "payment_intent" TEXT,
    "donor_name" TEXT,
    "comment" TEXT,
    "moderated" BOOLEAN NOT NULL DEFAULT false,
    "moderated_at" TIMESTAMP(3),
    "moderated_by" TEXT,
    "channel_id" TEXT,
    "event_id" TEXT,
    "hidden_from_overlay" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "refund_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Donation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "primary_channel_id" TEXT,
    "ended_at" TIMESTAMP(3),
    "ended_by" TEXT,
    "end_undone_at" TIMESTAMP(3),
    "end_undone_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "cost_cents" INTEGER NOT NULL,
    "quantity_total" INTEGER,
    "quantity_claimed" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "custom_type_label" TEXT,
    "image_url" TEXT,
    "channel_id" TEXT,
    "event_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardClaim" (
    "id" TEXT NOT NULL,
    "reward_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "amount_cents" INTEGER NOT NULL DEFAULT 0,
    "claim_data" TEXT,
    "donation_id" TEXT,
    "reversed_at" TIMESTAMP(3),
    "reversed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "chargeback_flagged_at" TIMESTAMP(3),
    "chargeback_acknowledged_at" TIMESTAMP(3),
    "chargeback_acknowledged_by" TEXT,
    "chargeback_acknowledgement_note" TEXT,

    CONSTRAINT "RewardClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Poll" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "ends_at" TIMESTAMP(3),
    "total_votes_cents" INTEGER NOT NULL DEFAULT 0,
    "allow_custom_entries" BOOLEAN NOT NULL DEFAULT false,
    "max_entry_chars" INTEGER,
    "auto_approve" BOOLEAN NOT NULL DEFAULT true,
    "channel_id" TEXT,
    "event_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Poll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollOption" (
    "id" TEXT NOT NULL,
    "poll_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "votes_cents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "custom_entry_id" TEXT,

    CONSTRAINT "PollOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollVote" (
    "id" TEXT NOT NULL,
    "poll_id" TEXT NOT NULL,
    "poll_option_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'donor',
    "allocated_by" TEXT,
    "allocated_at" TIMESTAMP(3),
    "donation_id" TEXT,
    "reversed_at" TIMESTAMP(3),
    "reversed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollCustomEntry" (
    "id" TEXT NOT NULL,
    "poll_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollCustomEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockedWord" (
    "id" TEXT NOT NULL,
    "word" TEXT NOT NULL,

    CONSTRAINT "BlockedWord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundGoal" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "target_cents" INTEGER NOT NULL,
    "current_cents" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_complete" BOOLEAN NOT NULL DEFAULT false,
    "channel_id" TEXT,
    "event_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundContribution" (
    "id" TEXT NOT NULL,
    "goal_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'donor',
    "allocated_by" TEXT,
    "allocated_at" TIMESTAMP(3),
    "donation_id" TEXT,
    "reversed_at" TIMESTAMP(3),
    "reversed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BalanceAdjustment" (
    "id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "balance_after_cents" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT,
    "reference_id" TEXT,
    "created_by" TEXT NOT NULL DEFAULT 'admin',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "donation_id" TEXT,
    "payment_refund_id" TEXT,
    "idempotency_key" TEXT,

    CONSTRAINT "BalanceAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingPledge" (
    "id" TEXT NOT NULL,
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
    "wallet_consumed_at" TIMESTAMP(3),
    "wallet_released_at" TIMESTAMP(3),
    "non_payment_confirmed_at" TIMESTAMP(3),
    "payment_status" TEXT,
    "checkout_session_status" TEXT,
    "reconciled_at" TIMESTAMP(3),
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "top_up_cents" INTEGER NOT NULL DEFAULT 0,
    "wallet_discount_cents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "requires_shipping" BOOLEAN NOT NULL DEFAULT false,
    "checkout_requested_at" TIMESTAMP(3),
    "checkout_request" TEXT,
    "checkout_session_id" TEXT,
    "checkout_url" TEXT,
    "comment" TEXT,
    "display_name" TEXT,
    "channel_id" TEXT,
    "fulfilled_by_donation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingPledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PledgeItem" (
    "id" TEXT NOT NULL,
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PledgeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoolCredit" (
    "id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "remaining_cents" INTEGER NOT NULL,
    "source_claim_id" TEXT,
    "source_vote_id" TEXT,
    "source_contribution_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleared_at" TIMESTAMP(3),
    "cleared_by" TEXT,

    CONSTRAINT "PoolCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoolCreditBatch" (
    "id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_data" TEXT NOT NULL,
    "result_data" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoolCreditBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoolCreditRedemption" (
    "id" TEXT NOT NULL,
    "credit_id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "reduced_cents" INTEGER NOT NULL DEFAULT 0,
    "claim_id" TEXT,
    "vote_id" TEXT,
    "contribution_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoolCreditRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventEndAudit" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventEndAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRefund" (
    "id" TEXT NOT NULL,
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "shipping_resolved_at" TIMESTAMP(3),
    "shipping_resolved_by" TEXT,

    CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelDefaultGoal" (
    "channel_id" TEXT NOT NULL,
    "goal_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ChannelDefaultGoal_pkey" PRIMARY KEY ("channel_id","goal_id")
);

-- CreateTable
CREATE TABLE "Auction" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "custom_type_label" TEXT,
    "image_url" TEXT,
    "starting_price_cents" INTEGER NOT NULL,
    "min_increment_cents" INTEGER NOT NULL,
    "current_bid_cents" INTEGER,
    "current_bidder_id" TEXT,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "current_offer_id" TEXT,
    "channel_id" TEXT,
    "event_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Auction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bid" (
    "id" TEXT NOT NULL,
    "auction_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "rank" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuctionOffer" (
    "id" TEXT NOT NULL,
    "auction_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "bid_id" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "checkout_session_id" TEXT,
    "checkout_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "emailed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuctionOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuctionWin" (
    "id" TEXT NOT NULL,
    "auction_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "winning_bid_cents" INTEGER NOT NULL,
    "checkout_session_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'FULFILLED',
    "reversed_at" TIMESTAMP(3),
    "reversed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuctionWin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "event_types" TEXT NOT NULL DEFAULT '[]',
    "verify_ssl" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "destination_type" TEXT NOT NULL DEFAULT 'HTTP',
    "amqp_url" TEXT,
    "amqp_exchange" TEXT NOT NULL DEFAULT '',
    "amqp_routing_key" TEXT,
    "payload_format" TEXT NOT NULL DEFAULT 'NATIVE',

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpointSeq" (
    "destination_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WebhookEndpointSeq_pkey" PRIMARY KEY ("destination_id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "message_id" TEXT NOT NULL,
    "destination_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "routing_key" TEXT,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "level" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Donor_email_key" ON "Donor"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Donor_magic_token_key" ON "Donor"("magic_token");

-- CreateIndex
CREATE UNIQUE INDEX "Donation_external_id_key" ON "Donation"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "Donation_refund_id_key" ON "Donation"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Event_primary_channel_id_key" ON "Event"("primary_channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_name_key" ON "Channel"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_slug_key" ON "Channel"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "PollOption_custom_entry_id_key" ON "PollOption"("custom_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedWord_word_key" ON "BlockedWord"("word");

-- CreateIndex
CREATE UNIQUE INDEX "BalanceAdjustment_payment_refund_id_key" ON "BalanceAdjustment"("payment_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "BalanceAdjustment_idempotency_key_key" ON "BalanceAdjustment"("idempotency_key");

-- CreateIndex
CREATE INDEX "BalanceAdjustment_donation_id_idx" ON "BalanceAdjustment"("donation_id");

-- CreateIndex
CREATE UNIQUE INDEX "PendingPledge_pledge_token_key" ON "PendingPledge"("pledge_token");

-- CreateIndex
CREATE UNIQUE INDEX "PendingPledge_fulfilled_by_donation_id_key" ON "PendingPledge"("fulfilled_by_donation_id");

-- CreateIndex
CREATE INDEX "PendingPledge_draft_id_idx" ON "PendingPledge"("draft_id");

-- CreateIndex
CREATE INDEX "PendingPledge_wallet_donor_id_wallet_hold_status_idx" ON "PendingPledge"("wallet_donor_id", "wallet_hold_status");

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

-- CreateIndex
CREATE UNIQUE INDEX "Auction_current_offer_id_key" ON "Auction"("current_offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionOffer_checkout_session_id_key" ON "AuctionOffer"("checkout_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionWin_auction_id_key" ON "AuctionWin"("auction_id");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_updated_at_idx" ON "WebhookDelivery"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_destination_id_seq_key" ON "WebhookDelivery"("destination_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_name_key" ON "FeatureFlag"("name");

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "BalanceAdjustment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_primary_channel_id_fkey" FOREIGN KEY ("primary_channel_id") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardClaim" ADD CONSTRAINT "RewardClaim_reward_id_fkey" FOREIGN KEY ("reward_id") REFERENCES "Reward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardClaim" ADD CONSTRAINT "RewardClaim_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardClaim" ADD CONSTRAINT "RewardClaim_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Poll" ADD CONSTRAINT "Poll_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Poll" ADD CONSTRAINT "Poll_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollOption" ADD CONSTRAINT "PollOption_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "Poll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollOption" ADD CONSTRAINT "PollOption_custom_entry_id_fkey" FOREIGN KEY ("custom_entry_id") REFERENCES "PollCustomEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "Poll"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_poll_option_id_fkey" FOREIGN KEY ("poll_option_id") REFERENCES "PollOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollCustomEntry" ADD CONSTRAINT "PollCustomEntry_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "Poll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollCustomEntry" ADD CONSTRAINT "PollCustomEntry_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundGoal" ADD CONSTRAINT "FundGoal_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundGoal" ADD CONSTRAINT "FundGoal_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundContribution" ADD CONSTRAINT "FundContribution_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "FundGoal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundContribution" ADD CONSTRAINT "FundContribution_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundContribution" ADD CONSTRAINT "FundContribution_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceAdjustment" ADD CONSTRAINT "BalanceAdjustment_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceAdjustment" ADD CONSTRAINT "BalanceAdjustment_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceAdjustment" ADD CONSTRAINT "BalanceAdjustment_payment_refund_id_fkey" FOREIGN KEY ("payment_refund_id") REFERENCES "PaymentRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingPledge" ADD CONSTRAINT "PendingPledge_fulfilled_by_donation_id_fkey" FOREIGN KEY ("fulfilled_by_donation_id") REFERENCES "Donation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingPledge" ADD CONSTRAINT "PendingPledge_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingPledge" ADD CONSTRAINT "PendingPledge_wallet_donor_id_fkey" FOREIGN KEY ("wallet_donor_id") REFERENCES "Donor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PledgeItem" ADD CONSTRAINT "PledgeItem_pledge_id_fkey" FOREIGN KEY ("pledge_id") REFERENCES "PendingPledge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolCredit" ADD CONSTRAINT "PoolCredit_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolCredit" ADD CONSTRAINT "PoolCredit_source_claim_id_fkey" FOREIGN KEY ("source_claim_id") REFERENCES "RewardClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolCredit" ADD CONSTRAINT "PoolCredit_source_vote_id_fkey" FOREIGN KEY ("source_vote_id") REFERENCES "PollVote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolCredit" ADD CONSTRAINT "PoolCredit_source_contribution_id_fkey" FOREIGN KEY ("source_contribution_id") REFERENCES "FundContribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolCreditBatch" ADD CONSTRAINT "PoolCreditBatch_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolCreditBatch" ADD CONSTRAINT "PoolCreditBatch_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolCreditRedemption" ADD CONSTRAINT "PoolCreditRedemption_credit_id_fkey" FOREIGN KEY ("credit_id") REFERENCES "PoolCredit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolCreditRedemption" ADD CONSTRAINT "PoolCreditRedemption_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "PoolCreditBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolCreditRedemption" ADD CONSTRAINT "PoolCreditRedemption_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "RewardClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolCreditRedemption" ADD CONSTRAINT "PoolCreditRedemption_vote_id_fkey" FOREIGN KEY ("vote_id") REFERENCES "PollVote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolCreditRedemption" ADD CONSTRAINT "PoolCreditRedemption_contribution_id_fkey" FOREIGN KEY ("contribution_id") REFERENCES "FundContribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventEndAudit" ADD CONSTRAINT "EventEndAudit_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "Donation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "RewardClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelDefaultGoal" ADD CONSTRAINT "ChannelDefaultGoal_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelDefaultGoal" ADD CONSTRAINT "ChannelDefaultGoal_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "FundGoal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Auction" ADD CONSTRAINT "Auction_current_offer_id_fkey" FOREIGN KEY ("current_offer_id") REFERENCES "AuctionOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Auction" ADD CONSTRAINT "Auction_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Auction" ADD CONSTRAINT "Auction_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Auction" ADD CONSTRAINT "Auction_current_bidder_id_fkey" FOREIGN KEY ("current_bidder_id") REFERENCES "Donor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_auction_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "Auction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionOffer" ADD CONSTRAINT "AuctionOffer_auction_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "Auction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionOffer" ADD CONSTRAINT "AuctionOffer_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionWin" ADD CONSTRAINT "AuctionWin_auction_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "Auction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionWin" ADD CONSTRAINT "AuctionWin_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpointSeq" ADD CONSTRAINT "WebhookEndpointSeq_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Non-Prisma invariants from the SQLite pooled-accounting migrations.
-- This baseline starts empty: historical backfills and table rebuilds do not apply.
ALTER TABLE "PoolCredit"
    ADD CONSTRAINT "PoolCredit_amount_check" CHECK (
        "amount_cents" > 0 AND "remaining_cents" >= 0 AND "remaining_cents" <= "amount_cents"
    ),
    ADD CONSTRAINT "PoolCredit_origin_check" CHECK (
        ("category" = 'reward' AND "source_claim_id" IS NOT NULL AND "source_vote_id" IS NULL AND "source_contribution_id" IS NULL) OR
        ("category" = 'poll' AND "source_vote_id" IS NOT NULL AND "source_claim_id" IS NULL AND "source_contribution_id" IS NULL) OR
        ("category" = 'goal' AND "source_contribution_id" IS NOT NULL AND "source_claim_id" IS NULL AND "source_vote_id" IS NULL)
    );

ALTER TABLE "PoolCreditRedemption"
    ADD CONSTRAINT "PoolCreditRedemption_target_check" CHECK (
        "amount_cents" > 0 AND num_nonnulls("claim_id", "vote_id", "contribution_id") = 1
    ),
    ADD CONSTRAINT "PoolCreditRedemption_reduced_cents_check" CHECK (
        "reduced_cents" >= 0 AND "reduced_cents" <= "amount_cents"
    );

ALTER TABLE "FundContribution"
    ADD CONSTRAINT "FundContribution_source_check" CHECK (
        "source" IN ('donor', 'auto', 'moderator') AND
        ("source" <> 'moderator' OR ("allocated_by" IS NOT NULL AND "allocated_at" IS NOT NULL))
    );

ALTER TABLE "PollVote"
    ADD CONSTRAINT "PollVote_source_check" CHECK (
        "source" IN ('donor', 'auto', 'moderator') AND
        ("source" <> 'moderator' OR ("allocated_by" IS NOT NULL AND "allocated_at" IS NOT NULL))
    );

ALTER TABLE "PendingPledge"
    ADD CONSTRAINT "PendingPledge_format_check" CHECK (
        ("format" = 'LEGACY' AND "pledge_amount_cents" IS NULL) OR
        ("format" = 'POOLED' AND "pledge_amount_cents" IS NOT NULL AND "pledge_amount_cents" >= 0 AND
         "draft_id" IS NOT NULL AND "confirmed_plan" IS NOT NULL AND "new_money_cents" IS NOT NULL AND
         "new_money_cents" >= 0 AND "pledge_amount_cents" = "new_money_cents" + "held_wallet_cents" AND
         "total_cents" = 0 AND "top_up_cents" = 0 AND "wallet_discount_cents" = 0)
    ),
    ADD CONSTRAINT "PendingPledge_hold_check" CHECK (
        ("held_wallet_cents" = 0 AND "wallet_hold_status" = 'NONE') OR
        ("held_wallet_cents" > 0 AND "wallet_donor_id" IS NOT NULL AND "wallet_hold_status" IN ('HELD', 'CONSUMED', 'RELEASED'))
    );

CREATE UNIQUE INDEX "PendingPledge_open_draft_key" ON "PendingPledge"("draft_id")
    WHERE "status" = 'OPEN' AND "draft_id" IS NOT NULL;
CREATE UNIQUE INDEX "PaymentRefund_requested_donation_key" ON "PaymentRefund"("donation_id")
    WHERE "status" = 'REQUESTED';

-- ADR-0012: Channel incentives belong to their Channel's Event; shared incentives
-- have no Channel. A cross-table lookup requires a trigger, not a CHECK.
CREATE FUNCTION "incentive_event_matches_channel"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    channel_event_id TEXT;
BEGIN
    IF NEW."channel_id" IS NOT NULL THEN
        -- Serialize this check with Channel moves, including concurrent writes.
        SELECT "event_id" INTO channel_event_id FROM "Channel"
        WHERE "id" = NEW."channel_id" FOR SHARE;
        IF NEW."event_id" IS DISTINCT FROM channel_event_id THEN
            RAISE EXCEPTION 'event_id must be the Event of channel_id'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "Reward_event_matches_channel_insert"
BEFORE INSERT ON "Reward"
FOR EACH ROW EXECUTE FUNCTION "incentive_event_matches_channel"();
CREATE TRIGGER "Reward_event_matches_channel_update"
BEFORE UPDATE OF "channel_id", "event_id" ON "Reward"
FOR EACH ROW EXECUTE FUNCTION "incentive_event_matches_channel"();
CREATE TRIGGER "Poll_event_matches_channel_insert"
BEFORE INSERT ON "Poll"
FOR EACH ROW EXECUTE FUNCTION "incentive_event_matches_channel"();
CREATE TRIGGER "Poll_event_matches_channel_update"
BEFORE UPDATE OF "channel_id", "event_id" ON "Poll"
FOR EACH ROW EXECUTE FUNCTION "incentive_event_matches_channel"();
CREATE TRIGGER "FundGoal_event_matches_channel_insert"
BEFORE INSERT ON "FundGoal"
FOR EACH ROW EXECUTE FUNCTION "incentive_event_matches_channel"();
CREATE TRIGGER "FundGoal_event_matches_channel_update"
BEFORE UPDATE OF "channel_id", "event_id" ON "FundGoal"
FOR EACH ROW EXECUTE FUNCTION "incentive_event_matches_channel"();
CREATE TRIGGER "Auction_event_matches_channel_insert"
BEFORE INSERT ON "Auction"
FOR EACH ROW EXECUTE FUNCTION "incentive_event_matches_channel"();
CREATE TRIGGER "Auction_event_matches_channel_update"
BEFORE UPDATE OF "channel_id", "event_id" ON "Auction"
FOR EACH ROW EXECUTE FUNCTION "incentive_event_matches_channel"();

CREATE FUNCTION "channel_keeps_event_with_incentives"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."event_id" IS DISTINCT FROM OLD."event_id" AND (
        EXISTS (SELECT 1 FROM "Reward" WHERE "channel_id" = OLD."id") OR
        EXISTS (SELECT 1 FROM "Poll" WHERE "channel_id" = OLD."id") OR
        EXISTS (SELECT 1 FROM "FundGoal" WHERE "channel_id" = OLD."id") OR
        EXISTS (SELECT 1 FROM "Auction" WHERE "channel_id" = OLD."id")
    ) THEN
        RAISE EXCEPTION 'A Channel with incentives cannot move to another Event'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "Channel_keeps_event_with_incentives"
BEFORE UPDATE OF "event_id" ON "Channel"
FOR EACH ROW EXECUTE FUNCTION "channel_keeps_event_with_incentives"();

COMMIT;
