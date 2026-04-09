ALTER TABLE "users"
ADD COLUMN "notify_sign_in_new_device" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "notify_browser_push" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "last_login_fingerprint" TEXT,
ADD COLUMN "last_login_at" TIMESTAMP(3);
