-- AlterTable
ALTER TABLE "Donation" ADD COLUMN "moderated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Donation" ADD COLUMN "moderated_at" DATETIME;
ALTER TABLE "Donation" ADD COLUMN "moderated_by" TEXT;
