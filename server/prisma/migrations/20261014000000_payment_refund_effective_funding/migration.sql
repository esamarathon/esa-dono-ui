-- Keep original credit consumption for audit; reversals restore only effective funding.
ALTER TABLE "PoolCreditRedemption" ADD COLUMN "reduced_cents" INTEGER NOT NULL DEFAULT 0
    CHECK ("reduced_cents" >= 0 AND "reduced_cents" <= "amount_cents");
