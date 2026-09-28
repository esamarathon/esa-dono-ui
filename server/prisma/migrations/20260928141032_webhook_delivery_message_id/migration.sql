-- PRD-0002 §Q9 / #109: add WebhookDelivery.message_id, drop max_attempts, index
-- (status, updated_at) for the retention sweep.
--
-- Hand-edited: Prisma's generated copy cannot fill a NOT NULL column whose default
-- is Prisma-level (uuid()). Existing rows get message_id = id, which is unique and
-- stable, so rows already queued keep one identity across the migration.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "message_id" TEXT NOT NULL,
    "destination_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "WebhookDelivery_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "WebhookEndpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WebhookDelivery" ("attempts", "created_at", "destination_id", "event_type", "id", "last_error", "last_status_code", "message_id", "next_attempt_at", "payload", "seq", "status", "updated_at") SELECT "attempts", "created_at", "destination_id", "event_type", "id", "last_error", "last_status_code", "id", "next_attempt_at", "payload", "seq", "status", "updated_at" FROM "WebhookDelivery";
DROP TABLE "WebhookDelivery";
ALTER TABLE "new_WebhookDelivery" RENAME TO "WebhookDelivery";
CREATE INDEX "WebhookDelivery_status_updated_at_idx" ON "WebhookDelivery"("status", "updated_at");
CREATE UNIQUE INDEX "WebhookDelivery_destination_id_seq_key" ON "WebhookDelivery"("destination_id", "seq");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
