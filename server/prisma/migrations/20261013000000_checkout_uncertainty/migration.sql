-- Persist intent before contacting Stripe. A lost create response must never
-- release Wallet funding or replay a pruned (>24h) idempotency key.
ALTER TABLE "PendingPledge" ADD COLUMN "checkout_requested_at" DATETIME;
ALTER TABLE "PendingPledge" ADD COLUMN "checkout_request" TEXT;
