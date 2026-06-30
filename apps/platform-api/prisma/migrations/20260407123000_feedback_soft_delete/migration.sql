-- Add soft delete support for feedback records.
ALTER TABLE "feedbacks"
ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "feedbacks_deleted_at_idx" ON "feedbacks"("deleted_at");
