ALTER TABLE "feedback_comments"
ADD COLUMN IF NOT EXISTS "parent_comment_id" TEXT;

CREATE INDEX IF NOT EXISTS "feedback_comments_feedback_id_parent_comment_id_created_at_idx"
ON "feedback_comments"("feedback_id", "parent_comment_id", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'feedback_comments_parent_comment_id_fkey'
  ) THEN
    ALTER TABLE "feedback_comments"
    ADD CONSTRAINT "feedback_comments_parent_comment_id_fkey"
    FOREIGN KEY ("parent_comment_id") REFERENCES "feedback_comments"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;
