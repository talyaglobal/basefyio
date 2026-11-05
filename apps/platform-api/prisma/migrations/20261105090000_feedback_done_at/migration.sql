-- Auto-close clock for DONE feedback. Additive; prod applies schema.prisma via db push.
ALTER TABLE "feedbacks" ADD COLUMN IF NOT EXISTS "done_at" TIMESTAMP(3);
