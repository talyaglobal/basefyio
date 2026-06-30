-- Store the app version that was active when the feedback was submitted.
ALTER TABLE "feedbacks" ADD COLUMN "app_version" TEXT;
