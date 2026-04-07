CREATE TABLE IF NOT EXISTS "feedback_events" (
  "id" TEXT NOT NULL,
  "feedback_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "detail" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feedback_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "feedback_events_feedback_id_created_at_idx"
ON "feedback_events"("feedback_id", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'feedback_events_feedback_id_fkey'
  ) THEN
    ALTER TABLE "feedback_events"
    ADD CONSTRAINT "feedback_events_feedback_id_fkey"
    FOREIGN KEY ("feedback_id") REFERENCES "feedbacks"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;
