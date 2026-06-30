-- Pending plan upgrade when immediate payment fails (invoice stays unpaid until collected).
ALTER TABLE "subscriptions" ADD COLUMN "pending_plan_id" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "pending_amount_due" INTEGER;
