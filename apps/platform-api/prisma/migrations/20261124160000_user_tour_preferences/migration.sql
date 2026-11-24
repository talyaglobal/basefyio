-- AlterTable
ALTER TABLE "users" ADD COLUMN     "tours_auto_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "tours_seen" TEXT[] DEFAULT ARRAY[]::TEXT[];