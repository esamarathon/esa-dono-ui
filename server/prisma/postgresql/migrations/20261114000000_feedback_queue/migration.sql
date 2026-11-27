-- Feedback queue (ported from the esa-crew-corner feedback bubble). Same model
-- as the SQLite migration; PostgreSQL syntax.
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "sender_id" TEXT,
    "message" TEXT NOT NULL,
    "page_url" TEXT NOT NULL DEFAULT '',
    "route" TEXT NOT NULL DEFAULT '',
    "viewport" TEXT NOT NULL DEFAULT '',
    "scroll_y" INTEGER NOT NULL DEFAULT 0,
    "user_agent" TEXT NOT NULL DEFAULT '',
    "screenshot_path" TEXT,
    "snapshot_path" TEXT,
    "diagnostics" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "resolution_note" TEXT NOT NULL DEFAULT '',
    "resolution_pr" TEXT NOT NULL DEFAULT '',
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Feedback_status_created_at_idx" ON "Feedback"("status", "created_at");
CREATE INDEX "Feedback_sender_id_idx" ON "Feedback"("sender_id");

ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "Donor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
