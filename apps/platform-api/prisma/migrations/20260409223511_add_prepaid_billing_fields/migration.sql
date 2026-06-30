-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CANCELLED');

-- AlterTable "teams" add account_status
ALTER TABLE "teams"
ADD COLUMN "account_status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable "subscriptions" add billing fields
ALTER TABLE "subscriptions"
ADD COLUMN "next_billing_date" TIMESTAMP(3),
ADD COLUMN "billing_day_of_month" INTEGER,
ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_retry_date" TIMESTAMP(3);

-- AlterTable "invoices" add retry fields
ALTER TABLE "invoices"
ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_retry_date" TIMESTAMP(3);
