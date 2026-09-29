-- Corrective migration: the hand-written `20260820000000_add_webhooks`
-- migration diverged from schema.prisma in three ways that break Prisma
-- writes against these tables:
--   1. `endpoint_id` columns where the models declare `destination_id`
--      (EventDelivery, EventDestinationSeq).
--   2. `TEXT ... DEFAULT (datetime('now'))` datetime columns where the models
--      declare `DateTime @default(now())` / `@updatedAt` (DATETIME).
--   3. `DEFAULT (lower(hex(randomblob(16))))` id defaults (harmless — Prisma
--      always supplies cuid() — but removed for consistency).
--
-- SQLite cannot ALTER a column's type or rename a column referenced by a
-- foreign key, so we rebuild the three tables in place. The tables hold no
-- production data (the webhook feature was never able to write to them), but
-- the INSERT..SELECT preserves any rows that may exist.

PRAGMA foreign_keys=OFF;

-- 1. WebhookEndpointSeq: endpoint_id -> destination_id
CREATE TABLE "new_WebhookEndpointSeq" (
    "destination_id" TEXT NOT NULL PRIMARY KEY,
    "seq" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "WebhookEndpointSeq_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "WebhookEndpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WebhookEndpointSeq" ("destination_id", "seq")
    SELECT "endpoint_id", "seq" FROM "WebhookEndpointSeq";
DROP TABLE "WebhookEndpointSeq";
ALTER TABLE "new_WebhookEndpointSeq" RENAME TO "WebhookEndpointSeq";

-- 2. WebhookEndpoint: TEXT datetime -> DATETIME
CREATE TABLE "new_WebhookEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "event_types" TEXT NOT NULL DEFAULT '[]',
    "verify_ssl" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "destination_type" TEXT NOT NULL DEFAULT 'HTTP',
    "amqp_url" TEXT,
    "amqp_exchange" TEXT NOT NULL DEFAULT '',
    "amqp_routing_key" TEXT
);
INSERT INTO "new_WebhookEndpoint"
    ("id", "url", "secret", "is_active", "event_types", "verify_ssl", "description", "created_at", "updated_at", "destination_type", "amqp_url", "amqp_exchange", "amqp_routing_key")
    SELECT "id", "url", "secret", "is_active", "event_types", "verify_ssl", "description", "created_at", "updated_at", "destination_type", "amqp_url", "amqp_exchange", "amqp_routing_key"
    FROM "WebhookEndpoint";
DROP TABLE "WebhookEndpoint";
ALTER TABLE "new_WebhookEndpoint" RENAME TO "WebhookEndpoint";

-- 3. WebhookDelivery: endpoint_id -> destination_id + TEXT datetime -> DATETIME
CREATE TABLE "new_WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "destination_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "WebhookDelivery_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "WebhookEndpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WebhookDelivery"
    ("id", "seq", "destination_id", "event_type", "payload", "status", "attempts", "max_attempts", "next_attempt_at", "last_status_code", "last_error", "created_at", "updated_at")
    SELECT "id", "seq", "endpoint_id", "event_type", "payload", "status", "attempts", "max_attempts", "next_attempt_at", "last_status_code", "last_error", "created_at", "updated_at"
    FROM "WebhookDelivery";
DROP TABLE "WebhookDelivery";
ALTER TABLE "new_WebhookDelivery" RENAME TO "WebhookDelivery";

CREATE UNIQUE INDEX "WebhookDelivery_destination_id_seq_key" ON "WebhookDelivery"("destination_id", "seq");
CREATE INDEX "WebhookDelivery_status_next_attempt_idx" ON "WebhookDelivery"("status", "next_attempt_at");

PRAGMA foreign_keys=ON;
