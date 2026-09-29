-- Webhook endpoints: admin-configured outbound webhook destinations.
CREATE TABLE "WebhookEndpoint" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  "url" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "is_active" INTEGER NOT NULL DEFAULT 1,
  "event_types" TEXT NOT NULL DEFAULT '[]',
  "verify_ssl" INTEGER NOT NULL DEFAULT 1,
  "description" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (datetime('now')),
  "updated_at" TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-endpoint monotonic seq counter for FIFO ordering.
CREATE TABLE "WebhookEndpointSeq" (
  "endpoint_id" TEXT NOT NULL PRIMARY KEY REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE,
  "seq" INTEGER NOT NULL DEFAULT 0
);

-- Delivery log ordered by seq per endpoint.
CREATE TABLE "WebhookDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  "seq" INTEGER NOT NULL DEFAULT 0,
  "endpoint_id" TEXT NOT NULL REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE,
  "event_type" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "next_attempt_at" TEXT NOT NULL DEFAULT (datetime('now')),
  "last_status_code" INTEGER,
  "last_error" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (datetime('now')),
  "updated_at" TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE("endpoint_id", "seq")
);

CREATE INDEX "WebhookDelivery_status_next_attempt_idx" ON "WebhookDelivery"("status", "next_attempt_at");
