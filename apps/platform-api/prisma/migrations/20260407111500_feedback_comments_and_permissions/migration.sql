CREATE TABLE "feedback_comments" (
  "id" TEXT NOT NULL,
  "feedback_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "comment" TEXT NOT NULL,
  "attachments" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feedback_comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "feedback_comments_feedback_id_created_at_idx"
ON "feedback_comments"("feedback_id", "created_at");

ALTER TABLE "feedback_comments"
ADD CONSTRAINT "feedback_comments_feedback_id_fkey"
FOREIGN KEY ("feedback_id") REFERENCES "feedbacks"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
