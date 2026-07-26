-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Poll" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "ends_at" DATETIME,
    "total_votes_cents" INTEGER NOT NULL DEFAULT 0,
    "allow_custom_entries" BOOLEAN NOT NULL DEFAULT false,
    "max_entry_chars" INTEGER,
    "auto_approve" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_Poll" ("allow_custom_entries", "created_at", "description", "ends_at", "id", "is_active", "max_entry_chars", "title", "total_votes_cents", "updated_at") SELECT "allow_custom_entries", "created_at", "description", "ends_at", "id", "is_active", "max_entry_chars", "title", "total_votes_cents", "updated_at" FROM "Poll";
DROP TABLE "Poll";
ALTER TABLE "new_Poll" RENAME TO "Poll";
CREATE TABLE "new_PollOption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poll_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "votes_cents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "custom_entry_id" TEXT,
    CONSTRAINT "PollOption_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "Poll" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PollOption_custom_entry_id_fkey" FOREIGN KEY ("custom_entry_id") REFERENCES "PollCustomEntry" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PollOption" ("custom_entry_id", "id", "label", "poll_id", "votes_cents") SELECT "custom_entry_id", "id", "label", "poll_id", "votes_cents" FROM "PollOption";
DROP TABLE "PollOption";
ALTER TABLE "new_PollOption" RENAME TO "PollOption";
CREATE UNIQUE INDEX "PollOption_custom_entry_id_key" ON "PollOption"("custom_entry_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

