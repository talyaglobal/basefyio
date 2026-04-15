-- AlterTable: add first_failure_at column to track time-based payment lockout
ALTER TABLE "subscriptions" ADD COLUMN "first_failure_at" TIMESTAMP(3);
