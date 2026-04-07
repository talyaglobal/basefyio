CREATE TABLE "login_security_states" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "failed_attempts" INTEGER NOT NULL DEFAULT 0,
  "consecutive_failed" INTEGER NOT NULL DEFAULT 0,
  "locked_until" TIMESTAMP(3),
  "captcha_question" TEXT,
  "captcha_answer" TEXT,
  "captcha_expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "login_security_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "login_security_states_email_key"
ON "login_security_states"("email");

CREATE INDEX "login_security_states_email_idx"
ON "login_security_states"("email");
