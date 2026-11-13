-- Feedback queue (ported from the esa-crew-corner feedback bubble). One table;
-- files live under FEEDBACK_DIR, referenced by relative paths. Rows are created
-- by the public POST /api/feedback endpoint; only admin routes read or update
-- them. Anonymous senders keep sender_id NULL; both donors are ON DELETE SET
-- NULL so a donor row is never blocked by its reports.
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "resolved_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Feedback_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "Donor" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "Feedback_status_created_at_idx" ON "Feedback"("status", "created_at");
CREATE INDEX "Feedback_sender_id_idx" ON "Feedback"("sender_id");
