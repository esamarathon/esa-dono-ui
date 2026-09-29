-- Add optional image_url column to Reward.
-- Existing rows get NULL (no image), which the client renders as today.
ALTER TABLE "Reward" ADD COLUMN "image_url" TEXT;
