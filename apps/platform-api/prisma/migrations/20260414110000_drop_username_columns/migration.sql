-- Drop username from platform users table
ALTER TABLE "users" DROP COLUMN "username";

-- Drop denormalized username snapshots from feedback tables
ALTER TABLE "feedbacks" DROP COLUMN "username";
ALTER TABLE "feedback_events" DROP COLUMN "username";
ALTER TABLE "feedback_comments" DROP COLUMN "username";
