-- AlterTable
ALTER TABLE "Donor" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'USER';

-- Backfill: existing moderators keep moderator access under the new role model.
UPDATE "Donor" SET "role" = 'MODERATOR' WHERE "is_moderator" = 1;

-- AlterTable
ALTER TABLE "Donor" DROP COLUMN "is_moderator";
