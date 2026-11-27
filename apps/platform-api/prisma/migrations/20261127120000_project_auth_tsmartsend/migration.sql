-- Per-project tsmartsend API key (stored encrypted by the application, like other credentials).
ALTER TABLE "project_auth_configs" ADD COLUMN "tsmartsend_api_key" TEXT;
