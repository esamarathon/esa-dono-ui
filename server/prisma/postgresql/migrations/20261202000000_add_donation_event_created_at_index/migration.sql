-- #250: the donor-site strip's donation acknowledgements read an Event's
-- ack-eligible donations of the last minute fresh on every poll (D8). This
-- index keeps that per-poll read cheap. Same model as the SQLite migration.
CREATE INDEX "Donation_event_id_created_at_idx" ON "Donation"("event_id", "created_at");
