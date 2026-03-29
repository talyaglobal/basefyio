-- AlterEnum (PostgreSQL: new enum value)
ALTER TYPE "UserRole" ADD VALUE 'ROOT';

-- AlterTable
ALTER TABLE "feedbacks" ADD COLUMN IF NOT EXISTS "attachments" JSONB;
