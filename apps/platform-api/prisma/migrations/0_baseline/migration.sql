-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER', 'ROOT');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DEACTIVATED', 'DELETED');

-- CreateEnum
CREATE TYPE "ProjectDatabaseType" AS ENUM ('RELATIONAL', 'NOSQL');

-- CreateEnum
CREATE TYPE "TeamMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED', 'TRIALING', 'INCOMPLETE');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InfraStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'MIGRATING', 'FAILED', 'DEPROVISIONING', 'STOPPED');

-- CreateEnum
CREATE TYPE "OrganizationKind" AS ENUM ('PERSONAL', 'COMPANY', 'STARTUP', 'AGENCY', 'EDUCATION', 'NONPROFIT', 'OPEN_SOURCE', 'OTHER');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "FeedbackType" AS ENUM ('BUG', 'FEATURE', 'GENERAL');

-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CLOSED');

-- CreateEnum
CREATE TYPE "DataPlaneStatus" AS ENUM ('PENDING', 'PROVISIONING', 'READY', 'FAILED', 'DELETING', 'DELETED');

-- CreateEnum
CREATE TYPE "MigrationArchiveStatus" AS ENUM ('CREATING', 'ACTIVE', 'DELETING', 'DELETED');

-- CreateEnum
CREATE TYPE "MigrationFileUploadStatus" AS ENUM ('PENDING', 'UPLOADING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "MigrationSource" AS ENUM ('USER_UPLOAD', 'WE_IMPORT');

-- CreateEnum
CREATE TYPE "MigrationRetention" AS ENUM ('TEMPORARY_30D', 'STANDARD_1Y', 'LONG_TERM');

-- CreateEnum
CREATE TYPE "MigrationRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "MigrationRestoreMode" AS ENUM ('SAME_PROJECT', 'NEW_PROJECT', 'EXPORT_BUNDLE');

-- CreateEnum
CREATE TYPE "MigrationJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "InvoiceLineItemType" AS ENUM ('PLAN', 'AI_TOKENS', 'MIGRATION_ARCHIVE_STORAGE');

-- CreateEnum
CREATE TYPE "DataStructureKind" AS ENUM ('RELATIONAL', 'JSON');

-- CreateEnum
CREATE TYPE "ProvisioningProjectStatus" AS ENUM ('PENDING', 'PROVISIONING', 'ACTIVE', 'UPDATING', 'DESTROYING', 'DESTROYED', 'FAILED', 'ROLLBACK_IN_PROGRESS', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ProvisioningResourceStatus" AS ENUM ('PENDING', 'CREATING', 'ACTIVE', 'UPDATING', 'DESTROYING', 'DESTROYED', 'FAILED', 'ROLLING_BACK', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ProvisioningOperationStatus" AS ENUM ('PENDING', 'DRY_RUN', 'RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL_FAILED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ProvisioningOperationType" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "ProvisioningResourceKind" AS ENUM ('SERVER', 'VOLUME', 'NETWORK', 'FIREWALL', 'LOAD_BALANCER', 'FLOATING_IP', 'SSH_KEY');

-- CreateEnum
CREATE TYPE "ProvisioningEventKind" AS ENUM ('STATUS_CHANGED', 'OPERATION_STARTED', 'OPERATION_COMPLETED', 'OPERATION_FAILED', 'DRY_RUN_COMPLETED', 'ROLLBACK_INITIATED', 'ROLLBACK_COMPLETED', 'CREDENTIAL_ROTATED', 'RESOURCE_CREATED', 'RESOURCE_UPDATED', 'RESOURCE_DESTROYED');

-- CreateEnum
CREATE TYPE "BlueprintStatus" AS ENUM ('DRAFT', 'APPROVED', 'GENERATING', 'GENERATED', 'FAILED');

-- CreateEnum
CREATE TYPE "MigrationStatus" AS ENUM ('PENDING', 'APPLIED', 'FAILED');

-- CreateEnum
CREATE TYPE "MarketingCampaignStatus" AS ENUM ('DRAFT', 'GENERATING', 'READY', 'PUBLISHING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "MarketingAssetKind" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO');

-- CreateEnum
CREATE TYPE "MarketingAssetStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "BackupVerificationStatus" AS ENUM ('RUNNING', 'PASSED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "BackupArtifactKind" AS ENUM ('AUTO_BACKUP', 'PITR_CLUSTER_BASE', 'PITR_PROJECT_BASE', 'PITR_WAL');

-- CreateEnum
CREATE TYPE "BackupCopyStatus" AS ENUM ('UPLOADED', 'FAILED');

-- CreateEnum
CREATE TYPE "PlatformIncidentStatus" AS ENUM ('INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "PlatformIncidentImpact" AS ENUM ('NONE', 'MINOR', 'MAJOR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "CapacityBenchmarkStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "active_team_id" TEXT,
    "avatar_url" TEXT,
    "github_username" TEXT,
    "notify_sign_in" BOOLEAN NOT NULL DEFAULT true,
    "notify_sign_in_new_device" BOOLEAN NOT NULL DEFAULT false,
    "notify_team_invite" BOOLEAN NOT NULL DEFAULT true,
    "notify_browser_push" BOOLEAN NOT NULL DEFAULT false,
    "last_login_fingerprint" TEXT,
    "last_login_at" TIMESTAMP(3),
    "mfa_enrolled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "can_access_management" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_users" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_teams" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_plans" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_user_packages" BOOLEAN NOT NULL DEFAULT false,
    "can_moderate_feedback" BOOLEAN NOT NULL DEFAULT false,
    "can_view_audit_logs" BOOLEAN NOT NULL DEFAULT false,
    "can_view_root_alerts" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "personal_for_user_id" TEXT,
    "account_status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "public_id" VARCHAR(24),
    "kind" "OrganizationKind" NOT NULL DEFAULT 'COMPANY',
    "description" VARCHAR(512),
    "website_url" VARCHAR(512),
    "logo_url" VARCHAR(1024),
    "organization_migrated_at" TIMESTAMP(3),
    "require_mfa" BOOLEAN NOT NULL DEFAULT false,
    "require_mfa_updated_at" TIMESTAMP(3),
    "github_oauth_token" TEXT,
    "github_oauth_login" TEXT,
    "github_oauth_avatar" TEXT,
    "vercel_oauth_token" TEXT,
    "vercel_oauth_team_id" TEXT,
    "vercel_oauth_user" TEXT,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "TeamMemberRole" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_role_permissions" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "role" "TeamMemberRole" NOT NULL,
    "can_rename_team" BOOLEAN NOT NULL DEFAULT false,
    "can_invite_members" BOOLEAN NOT NULL DEFAULT false,
    "can_remove_members" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_integrations" BOOLEAN NOT NULL DEFAULT false,
    "can_create_projects" BOOLEAN NOT NULL DEFAULT false,
    "can_delete_projects" BOOLEAN NOT NULL DEFAULT false,
    "can_restore_projects" BOOLEAN NOT NULL DEFAULT false,
    "can_move_projects" BOOLEAN NOT NULL DEFAULT false,
    "can_reset_db_password" BOOLEAN NOT NULL DEFAULT false,
    "can_view_billing" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_billing" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "team_role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_invites" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "invited_user_id" TEXT,
    "invited_email" TEXT,
    "invited_by_id" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "db_name" TEXT NOT NULL,
    "db_host" TEXT NOT NULL DEFAULT 'localhost',
    "db_port" INTEGER NOT NULL DEFAULT 5432,
    "db_user" TEXT NOT NULL,
    "db_password" TEXT NOT NULL,
    "keycloak_realm" TEXT NOT NULL,
    "anon_key" TEXT NOT NULL,
    "service_key" TEXT NOT NULL,
    "service_key_last_used_at" TIMESTAMP(3),
    "team_id" TEXT NOT NULL,
    "created_by" TEXT,
    "import_source" TEXT NOT NULL DEFAULT 'MANUAL',
    "database_type" "ProjectDatabaseType" NOT NULL DEFAULT 'RELATIONAL',
    "supabase_import_log" JSONB,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deactivated_at" TIMESTAMP(3),
    "paused_at" TIMESTAMP(3),
    "idle_warning_sent_at" TIMESTAMP(3),
    "rls_bootstrapped_at" TIMESTAMP(3),
    "storage_authz" TEXT NOT NULL DEFAULT 'presets',
    "supabase_compat" BOOLEAN NOT NULL DEFAULT false,
    "folder_id" TEXT,
    "github_token" TEXT,
    "github_owner" TEXT,
    "github_repo" TEXT,
    "github_branch" TEXT DEFAULT 'main',
    "vercel_token" TEXT,
    "vercel_project_id" TEXT,
    "vercel_team_id" TEXT,
    "pgvector_enabled" BOOLEAN NOT NULL DEFAULT false,
    "pgvector_enabled_at" TIMESTAMP(3),
    "embedding_api_key" TEXT,
    "embedding_provider" VARCHAR(32),
    "embedding_model" VARCHAR(120),
    "embedding_base_url" TEXT,
    "embedding_reembed_state" JSONB,
    "modules" JSONB NOT NULL DEFAULT '{}',
    "storage_prefix" TEXT,
    "max_rows_per_table" INTEGER NOT NULL DEFAULT 1000,
    "db_readonly_user" TEXT,
    "db_readonly_password" TEXT,
    "max_db_connections" INTEGER,
    "parent_project_id" TEXT,
    "branch_name" TEXT,
    "branch_data_mode" TEXT,
    "branch_sync_status" TEXT,
    "branch_sync_error" TEXT,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_extra_roles" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "role_name" VARCHAR(63) NOT NULL,
    "password" TEXT NOT NULL,
    "member_of" VARCHAR(16) NOT NULL DEFAULT 'none',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_extra_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "realtime_bindings" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realtime_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_activity_logs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT,
    "kind" VARCHAR(80) NOT NULL,
    "title" VARCHAR(512) NOT NULL,
    "detail" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_folders" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "team_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#8b5cf6',
    "team_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_tag_assignments" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,

    CONSTRAINT "project_tag_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_auth_configs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "allow_signup" BOOLEAN NOT NULL DEFAULT true,
    "require_email_verify" BOOLEAN NOT NULL DEFAULT true,
    "min_password_length" INTEGER NOT NULL DEFAULT 6,
    "token_expiry_seconds" INTEGER NOT NULL DEFAULT 1800,
    "email_provider" TEXT,
    "smtp_host" TEXT,
    "smtp_port" INTEGER,
    "smtp_user" TEXT,
    "smtp_pass" TEXT,
    "sender_email" TEXT,
    "sender_name" TEXT,
    "resend_api_key" TEXT,
    "sendgrid_api_key" TEXT,
    "ses_access_key" TEXT,
    "ses_secret_key" TEXT,
    "ses_region" TEXT,
    "verify_email_subject" TEXT,
    "verify_email_body" TEXT,
    "reset_password_subject" TEXT,
    "reset_password_body" TEXT,
    "welcome_subject" TEXT,
    "welcome_body" TEXT,
    "invite_user_subject" TEXT,
    "invite_user_body" TEXT,
    "magic_link_subject" TEXT,
    "magic_link_body" TEXT,
    "change_email_subject" TEXT,
    "change_email_body" TEXT,
    "reauth_subject" TEXT,
    "reauth_body" TEXT,
    "redirect_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "google_enabled" BOOLEAN NOT NULL DEFAULT false,
    "google_client_id" TEXT,
    "google_client_secret" TEXT,
    "github_enabled" BOOLEAN NOT NULL DEFAULT false,
    "github_client_id" TEXT,
    "github_client_secret" TEXT,
    "microsoft_enabled" BOOLEAN NOT NULL DEFAULT false,
    "microsoft_client_id" TEXT,
    "microsoft_client_secret" TEXT,
    "apple_enabled" BOOLEAN NOT NULL DEFAULT false,
    "apple_client_id" TEXT,
    "apple_client_secret" TEXT,
    "gitlab_enabled" BOOLEAN NOT NULL DEFAULT false,
    "gitlab_client_id" TEXT,
    "gitlab_client_secret" TEXT,
    "linkedin_enabled" BOOLEAN NOT NULL DEFAULT false,
    "linkedin_client_id" TEXT,
    "linkedin_client_secret" TEXT,
    "facebook_enabled" BOOLEAN NOT NULL DEFAULT false,
    "facebook_client_id" TEXT,
    "facebook_client_secret" TEXT,
    "twitter_enabled" BOOLEAN NOT NULL DEFAULT false,
    "twitter_client_id" TEXT,
    "twitter_client_secret" TEXT,
    "allow_anonymous" BOOLEAN NOT NULL DEFAULT false,
    "mfa_enforce_enrollment" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "project_auth_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_user_mfa" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "keycloak_user_id" TEXT NOT NULL,
    "totp_secret_enc" TEXT,
    "pending_secret_enc" TEXT,
    "pending_created_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "last_used_step" INTEGER,
    "last_used_at" TIMESTAMP(3),
    "recovery_code_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enrollment_required_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_user_mfa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imported_password_hashes" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "keycloak_user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "source" TEXT NOT NULL DEFAULT 'supabase',
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "imported_password_hashes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sql_audit_logs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "row_count" INTEGER,
    "duration" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sql_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "realm" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "feedbacks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "attachments" JSONB,
    "type" "FeedbackType" NOT NULL DEFAULT 'GENERAL',
    "status" "FeedbackStatus" NOT NULL DEFAULT 'OPEN',
    "app_version" TEXT,
    "deleted_at" TIMESTAMP(3),
    "done_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "href" TEXT,
    "dedupe_key" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_events" (
    "id" TEXT NOT NULL,
    "feedback_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_comments" (
    "id" TEXT NOT NULL,
    "feedback_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "comment" TEXT NOT NULL,
    "attachments" JSONB,
    "parent_comment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),

    CONSTRAINT "feedback_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "max_projects" INTEGER,
    "max_storage_bytes" BIGINT,
    "max_team_members" INTEGER,
    "max_db_size_bytes" BIGINT,
    "max_api_requests" INTEGER,
    "max_bandwidth_bytes" BIGINT,
    "max_mau" INTEGER,
    "max_db_connections" INTEGER,
    "dedicated_db" BOOLEAN NOT NULL DEFAULT false,
    "dedicated_storage" BOOLEAN NOT NULL DEFAULT false,
    "db_memory_mb" INTEGER NOT NULL DEFAULT 0,
    "db_cpu_millis" INTEGER NOT NULL DEFAULT 0,
    "price_monthly" INTEGER NOT NULL DEFAULT 0,
    "stripe_price_id" TEXT,
    "stripe_product_id" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "features" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "next_billing_date" TIMESTAMP(3),
    "billing_day_of_month" INTEGER,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_retry_date" TIMESTAMP(3),
    "first_failure_at" TIMESTAMP(3),
    "pending_plan_id" TEXT,
    "pending_amount_due" INTEGER,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "student_discount_percent" INTEGER NOT NULL DEFAULT 0,
    "student_verified_email" TEXT,
    "student_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "stripe_invoice_id" TEXT,
    "amount_due" INTEGER NOT NULL,
    "amount_paid" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL,
    "invoice_url" TEXT,
    "invoice_pdf" TEXT,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_retry_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_accounts" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "company_name" TEXT,
    "tax_id" TEXT,
    "vat_number" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "country" TEXT,
    "billing_email" TEXT,
    "phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_usage" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "project_count" INTEGER NOT NULL DEFAULT 0,
    "storage_bytes" BIGINT NOT NULL DEFAULT 0,
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "db_size_bytes" BIGINT NOT NULL DEFAULT 0,
    "api_requests_month" INTEGER NOT NULL DEFAULT 0,
    "bandwidth_month" BIGINT NOT NULL DEFAULT 0,
    "mau_count" INTEGER NOT NULL DEFAULT 0,
    "period_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "project_id" TEXT,
    "metric" TEXT NOT NULL,
    "value" BIGINT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_usage" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "db_size_bytes" BIGINT NOT NULL DEFAULT 0,
    "storage_bytes" BIGINT NOT NULL DEFAULT 0,
    "api_requests_month" INTEGER NOT NULL DEFAULT 0,
    "bandwidth_month" BIGINT NOT NULL DEFAULT 0,
    "period_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storage_calculated_at" TIMESTAMP(3),
    "db_size_calculated_at" TIMESTAMP(3),
    "last_calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_request_at" TIMESTAMP(3),

    CONSTRAINT "project_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_infrastructure" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "pg_container_name" TEXT,
    "pg_container_host" TEXT,
    "pg_container_port" INTEGER,
    "pg_admin_user" TEXT,
    "pg_admin_password" TEXT,
    "pg_memory_mb" INTEGER NOT NULL DEFAULT 1024,
    "pg_cpu_millis" INTEGER NOT NULL DEFAULT 1000,
    "pg_volume_id" TEXT,
    "status" "InfraStatus" NOT NULL DEFAULT 'PROVISIONING',
    "provisioned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_infrastructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_infrastructure" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "minio_container_name" TEXT,
    "minio_container_host" TEXT,
    "minio_container_port" INTEGER,
    "minio_access_key" TEXT,
    "minio_secret_key" TEXT,
    "minio_volume_id" TEXT,
    "status" "InfraStatus" NOT NULL DEFAULT 'PROVISIONING',
    "provisioned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_infrastructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "trace_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "severity" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "before_json" JSONB,
    "after_json" JSONB,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "root_alerts" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "related_audit_log_id" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "root_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" VARCHAR(128) NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "embedding_records" (
    "id" TEXT NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "entity_id" TEXT NOT NULL,
    "project_id" TEXT,
    "team_id" TEXT,
    "token_count" INTEGER,
    "embedding_model" VARCHAR(80) NOT NULL DEFAULT 'text-embedding-3-small',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "embedding_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_plane_provisioning" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" "DataPlaneStatus" NOT NULL DEFAULT 'PENDING',
    "provider" VARCHAR(20) NOT NULL DEFAULT 'nosql',
    "namespace" TEXT NOT NULL DEFAULT 'projects',
    "tier" VARCHAR(20) NOT NULL DEFAULT 'shared',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "provisioned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_plane_provisioning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_models" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_definitions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "application_model_id" TEXT,
    "logical_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "physical_collection" TEXT NOT NULL,
    "storage_strategy" VARCHAR(30) NOT NULL DEFAULT 'shared-records',
    "provider" VARCHAR(20) NOT NULL DEFAULT 'nosql',
    "storage_class" VARCHAR(20) NOT NULL DEFAULT 'standard',
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "rules" JSONB NOT NULL DEFAULT '[]',
    "generated_by_ai" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "icon" VARCHAR(50),
    "ai_prompt" TEXT,
    "ai_reasoning" JSONB,
    "confidence_score" DOUBLE PRECISION,
    "source_workbook" TEXT,
    "source_sheet" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_schema_versions" (
    "id" TEXT NOT NULL,
    "entity_definition_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "migration_script" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_schema_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_name_mappings" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "logical_name" TEXT NOT NULL,
    "physical_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_name_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_engine_outbox" (
    "id" TEXT NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "project_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "document_id" TEXT,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_engine_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_data_queries" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" VARCHAR(20) NOT NULL,
    "entity" TEXT,
    "sql" TEXT,
    "pipeline" JSONB,
    "params_schema" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_data_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migration_archives" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "bucket_name" TEXT NOT NULL,
    "status" "MigrationArchiveStatus" NOT NULL DEFAULT 'CREATING',
    "source" "MigrationSource" NOT NULL,
    "retention" "MigrationRetention" NOT NULL DEFAULT 'STANDARD_1Y',
    "region" VARCHAR(10) NOT NULL,
    "encrypted_at_rest" BOOLEAN NOT NULL DEFAULT true,
    "consent_completed_at" TIMESTAMP(3),
    "total_bytes" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "migration_archives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migration_archive_files" (
    "id" TEXT NOT NULL,
    "archive_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "content_type" VARCHAR(80),
    "upload_status" "MigrationFileUploadStatus" NOT NULL DEFAULT 'PENDING',
    "uploaded_bytes" BIGINT NOT NULL DEFAULT 0,
    "chunk_size" INTEGER,
    "checksum" VARCHAR(128),
    "resume_token" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "migration_archive_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migration_assessments" (
    "id" TEXT NOT NULL,
    "archive_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "tables_found" INTEGER NOT NULL,
    "records_found" BIGINT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "relationships" INTEGER NOT NULL,
    "nested_json_structures" INTEGER NOT NULL,
    "legacy_files" JSONB NOT NULL,
    "shape" VARCHAR(20) NOT NULL,
    "detected_entities" JSONB NOT NULL,
    "recommendation" JSONB NOT NULL,
    "complexity" VARCHAR(20) NOT NULL,
    "confidence_pct" DOUBLE PRECISION NOT NULL,
    "fully_automatable" BOOLEAN NOT NULL,
    "human_involvement_pct" DOUBLE PRECISION NOT NULL,
    "estimated_people_hours" DOUBLE PRECISION NOT NULL,
    "estimated_manual_review_hours" DOUBLE PRECISION NOT NULL,
    "estimated_engineering_hours" DOUBLE PRECISION NOT NULL,
    "estimated_duration_days" DOUBLE PRECISION NOT NULL,
    "hourly_rate_cents" INTEGER NOT NULL,
    "estimated_cost_cents" INTEGER NOT NULL,
    "data_loss_risk_pct" DOUBLE PRECISION NOT NULL,
    "risk_level" "MigrationRiskLevel" NOT NULL,
    "risk_drivers" JSONB NOT NULL,
    "mitigations" JSONB NOT NULL,
    "businessImpact" TEXT NOT NULL,
    "final_recommendation" JSONB NOT NULL,
    "estimated_archive_size_bytes" BIGINT NOT NULL,
    "estimated_monthly_archive_cost_cents" INTEGER NOT NULL,
    "app_preview" JSONB,
    "assessment_version" INTEGER NOT NULL DEFAULT 1,
    "model_version" VARCHAR(80) NOT NULL,
    "superseded_by_id" TEXT,
    "report_pdf_object_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "migration_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migration_restore_jobs" (
    "id" TEXT NOT NULL,
    "archive_id" TEXT NOT NULL,
    "source_project_id" TEXT NOT NULL,
    "target_project_id" TEXT,
    "mode" "MigrationRestoreMode" NOT NULL,
    "status" "MigrationJobStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "result_object_key" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "migration_restore_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migration_import_credentials" (
    "id" TEXT NOT NULL,
    "archive_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "openbao_path" TEXT NOT NULL,
    "engine_kind" VARCHAR(30) NOT NULL,
    "metadata_scanned_at" TIMESTAMP(3),
    "data_read_consent_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "migration_import_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migration_consents" (
    "id" TEXT NOT NULL,
    "archive_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL,
    "ip_address" VARCHAR(45) NOT NULL,
    "privacy_statement_version" VARCHAR(20) NOT NULL,
    "risk_statement_version" VARCHAR(20) NOT NULL,
    "archive_policy_version" VARCHAR(20) NOT NULL,
    "accepted_items" JSONB NOT NULL,
    "sensitive_data_flags" JSONB NOT NULL,
    "db_access_authorized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "migration_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migration_archive_ledgers" (
    "id" TEXT NOT NULL,
    "archive_id" TEXT NOT NULL,
    "stored_bytes" BIGINT NOT NULL DEFAULT 0,
    "growth_bytes" BIGINT NOT NULL DEFAULT 0,
    "accumulated_cents" INTEGER NOT NULL DEFAULT 0,
    "last_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "migration_archive_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "type" "InvoiceLineItemType" NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_cents" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "archive_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_structures" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "DataStructureKind" NOT NULL,
    "json_backend" VARCHAR(20),
    "ai_recommended" BOOLEAN NOT NULL DEFAULT false,
    "ai_reasons" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_structure_storages" (
    "id" TEXT NOT NULL,
    "data_structure_id" TEXT NOT NULL,
    "engine_type" VARCHAR(20) NOT NULL,
    "endpoint_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_structure_storages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_engine_endpoints" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "engine_type" VARCHAR(20) NOT NULL,
    "host" VARCHAR(255) NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "credential_ref" TEXT NOT NULL,
    "requires_client_cert" BOOLEAN NOT NULL DEFAULT true,
    "access_level" VARCHAR(20) NOT NULL DEFAULT 'READ_WRITE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_engine_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisioning_projects" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" "ProvisioningProjectStatus" NOT NULL DEFAULT 'PENDING',
    "provider" VARCHAR(30) NOT NULL DEFAULT 'hetzner',
    "region" VARCHAR(30) NOT NULL,
    "datacenter" VARCHAR(60),
    "credential_ref_id" TEXT NOT NULL,
    "desired_state" JSONB,
    "actual_state" JSONB,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provisioning_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisioning_resources" (
    "id" TEXT NOT NULL,
    "provisioning_project_id" TEXT NOT NULL,
    "kind" "ProvisioningResourceKind" NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "status" "ProvisioningResourceStatus" NOT NULL DEFAULT 'PENDING',
    "region" VARCHAR(30) NOT NULL,
    "datacenter" VARCHAR(60),
    "external_id" VARCHAR(128),
    "desired_spec" JSONB NOT NULL,
    "actual_spec" JSONB,
    "rollback_spec" JSONB,
    "last_synced_at" TIMESTAMP(3),
    "destroyed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provisioning_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisioning_operations" (
    "id" TEXT NOT NULL,
    "provisioning_project_id" TEXT NOT NULL,
    "resource_id" TEXT,
    "type" "ProvisioningOperationType" NOT NULL,
    "status" "ProvisioningOperationStatus" NOT NULL DEFAULT 'PENDING',
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "requested_by" TEXT NOT NULL,
    "input" JSONB,
    "result" JSONB,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provisioning_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisioning_credential_refs" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "provider" VARCHAR(30) NOT NULL DEFAULT 'hetzner',
    "label" VARCHAR(100) NOT NULL,
    "openbao_path" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provisioning_credential_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisioning_audit_events" (
    "id" TEXT NOT NULL,
    "provisioning_project_id" TEXT NOT NULL,
    "resource_id" TEXT,
    "operation_id" TEXT,
    "kind" "ProvisioningEventKind" NOT NULL,
    "actor_user_id" TEXT,
    "from_status" VARCHAR(40),
    "to_status" VARCHAR(40),
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provisioning_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quickbooks_connection" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "realm_id" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "refresh_expires_at" TIMESTAMP(3),
    "company_name" TEXT,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "auto_create" BOOLEAN NOT NULL DEFAULT true,
    "connected_by_user_id" TEXT,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quickbooks_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quickbooks_sync_log" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "team_id" TEXT,
    "sales_receipt_id" TEXT,
    "amount_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "customer_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'success',
    "error" TEXT,
    "intuit_tid" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quickbooks_sync_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "management_doc" (
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "management_doc_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "tech_docs" (
    "slug" VARCHAR(80) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "section" VARCHAR(80) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 999,
    "summary" VARCHAR(500) NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "source_commit" VARCHAR(40),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tech_docs_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "flow" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "next_run_at" TIMESTAMP(3),
    "webhook_secret" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_run" (
    "id" TEXT NOT NULL,
    "flow_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "input" JSONB,
    "result" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flow_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "project_id" TEXT,
    "name" TEXT NOT NULL,
    "status" "BlueprintStatus" NOT NULL DEFAULT 'DRAFT',
    "domain" TEXT,
    "data_model" JSONB NOT NULL,
    "business_model" JSONB,
    "application_model" JSONB,
    "generated_data_model" JSONB,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blueprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_version" (
    "id" TEXT NOT NULL,
    "blueprint_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "application_model" JSONB NOT NULL,
    "change_summary" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migration_run" (
    "id" TEXT NOT NULL,
    "blueprint_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" "MigrationStatus" NOT NULL DEFAULT 'PENDING',
    "plan" JSONB NOT NULL,
    "applied_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "migration_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_api_token" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "team_id" TEXT,
    "name" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_api_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'instagram',
    "integration_id" TEXT,
    "status" "MarketingCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "language" TEXT NOT NULL DEFAULT 'en',
    "tone" TEXT,
    "caption" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "image_prompt" TEXT,
    "video_prompt" TEXT,
    "voice_script" TEXT,
    "pubbler_post_id" TEXT,
    "publish_mode" TEXT,
    "published_at" TIMESTAMP(3),
    "error" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_asset" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "kind" "MarketingAssetKind" NOT NULL,
    "status" "MarketingAssetStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "prompt" TEXT,
    "url" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_chat_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "project_id" TEXT,
    "title" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_chat_messages" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "role" VARCHAR(16) NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_verifications" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" "BackupVerificationStatus" NOT NULL DEFAULT 'RUNNING',
    "backup_bucket" TEXT,
    "backup_object_key" TEXT,
    "backup_taken_at" TIMESTAMP(3),
    "archive_bytes" BIGINT,
    "verify_db_name" TEXT,
    "tables_expected" INTEGER,
    "tables_restored" INTEGER,
    "rows_mismatched" INTEGER,
    "psql_error_count" INTEGER,
    "counts_compared" BOOLEAN NOT NULL DEFAULT false,
    "details" JSONB,
    "error" TEXT,
    "requested_by" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,

    CONSTRAINT "backup_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_offsite_copies" (
    "id" TEXT NOT NULL,
    "kind" "BackupArtifactKind" NOT NULL,
    "project_id" TEXT,
    "local_bucket" TEXT NOT NULL,
    "local_key" TEXT NOT NULL,
    "remote_bucket" TEXT NOT NULL,
    "remote_key" TEXT NOT NULL,
    "plain_bytes" BIGINT NOT NULL,
    "encrypted" BOOLEAN NOT NULL,
    "status" "BackupCopyStatus" NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_offsite_copies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_upload_sessions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "total_size" BIGINT NOT NULL,
    "uploaded_size" BIGINT NOT NULL DEFAULT 0,
    "chunk_size" INTEGER NOT NULL,
    "upload_id" TEXT NOT NULL,
    "parts" JSONB NOT NULL DEFAULT '[]',
    "owner_sub" TEXT,
    "caller_kind" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_policies" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "path_prefix" TEXT NOT NULL DEFAULT '',
    "mode" VARCHAR(24) NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_alerts" (
    "id" TEXT NOT NULL,
    "source" VARCHAR(40) NOT NULL,
    "kind" VARCHAR(60) NOT NULL,
    "severity" VARCHAR(16) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "detail" TEXT,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_probe_samples" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "probe" VARCHAR(40) NOT NULL,
    "vantage" VARCHAR(40) NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "latency_ms" INTEGER,
    "status_code" INTEGER,
    "detail" VARCHAR(300),

    CONSTRAINT "platform_probe_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_slo_windows" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "probe" VARCHAR(40) NOT NULL,
    "total_minutes" INTEGER NOT NULL,
    "down_minutes" INTEGER NOT NULL,
    "p95_latency_ms" INTEGER,
    "error_rate_pct" DOUBLE PRECISION,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_slo_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_slo_months" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "probe" VARCHAR(40) NOT NULL,
    "total_minutes" INTEGER NOT NULL,
    "down_minutes" INTEGER NOT NULL,
    "availability_pct" DOUBLE PRECISION,
    "target_pct" DOUBLE PRECISION NOT NULL,
    "p95_latency_ms" INTEGER,
    "incident_count" INTEGER NOT NULL DEFAULT 0,
    "closed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_slo_months_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_status_subscribers" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "unsubscribed_at" TIMESTAMP(3),
    "last_notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_status_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_incidents" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "status" "PlatformIncidentStatus" NOT NULL DEFAULT 'INVESTIGATING',
    "impact" "PlatformIncidentImpact" NOT NULL DEFAULT 'MINOR',
    "components" TEXT[],
    "started_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "updates" JSONB NOT NULL DEFAULT '[]',
    "postmortem" TEXT,
    "excluded_from_slo" BOOLEAN NOT NULL DEFAULT false,
    "auto_key" VARCHAR(80),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_deploy_markers" (
    "id" TEXT NOT NULL,
    "image_tag" VARCHAR(80) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" VARCHAR(300),

    CONSTRAINT "platform_deploy_markers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_samples" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "instance_id" VARCHAR(80) NOT NULL,
    "metrics" JSONB NOT NULL,

    CONSTRAINT "capacity_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_rollups" (
    "id" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB NOT NULL,

    CONSTRAINT "capacity_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_model_snapshots" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "capacity_model_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_benchmark_runs" (
    "id" TEXT NOT NULL,
    "scenario" VARCHAR(40) NOT NULL,
    "target" VARCHAR(40) NOT NULL,
    "status" "CapacityBenchmarkStatus" NOT NULL DEFAULT 'PENDING',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "params" JSONB,
    "result" JSONB,
    "triggered_by" TEXT,

    CONSTRAINT "capacity_benchmark_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_secret_keys" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "project_secret_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_key" ON "role_permissions"("role");

-- CreateIndex
CREATE UNIQUE INDEX "teams_slug_key" ON "teams"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "teams_personal_for_user_id_key" ON "teams"("personal_for_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_public_id_key" ON "teams"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_team_id_user_id_key" ON "team_members"("team_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_role_permissions_team_id_role_key" ON "team_role_permissions"("team_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "team_invites_team_id_invited_user_id_key" ON "team_invites"("team_id", "invited_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_invites_team_id_invited_email_key" ON "team_invites"("team_id", "invited_email");

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "projects_parent_project_id_idx" ON "projects"("parent_project_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_parent_project_id_branch_name_key" ON "projects"("parent_project_id", "branch_name");

-- CreateIndex
CREATE INDEX "project_extra_roles_project_id_idx" ON "project_extra_roles"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_extra_roles_project_id_role_name_key" ON "project_extra_roles"("project_id", "role_name");

-- CreateIndex
CREATE UNIQUE INDEX "realtime_bindings_project_id_kind_entity_key" ON "realtime_bindings"("project_id", "kind", "entity");

-- CreateIndex
CREATE INDEX "project_activity_logs_project_id_created_at_idx" ON "project_activity_logs"("project_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "project_tags_team_id_name_key" ON "project_tags"("team_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "project_tag_assignments_project_id_tag_id_key" ON "project_tag_assignments"("project_id", "tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_auth_configs_project_id_key" ON "project_auth_configs"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_user_mfa_project_id_keycloak_user_id_key" ON "project_user_mfa"("project_id", "keycloak_user_id");

-- CreateIndex
CREATE INDEX "imported_password_hashes_project_id_email_idx" ON "imported_password_hashes"("project_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "imported_password_hashes_project_id_keycloak_user_id_key" ON "imported_password_hashes"("project_id", "keycloak_user_id");

-- CreateIndex
CREATE INDEX "sql_audit_logs_project_id_idx" ON "sql_audit_logs"("project_id");

-- CreateIndex
CREATE INDEX "sql_audit_logs_user_id_idx" ON "sql_audit_logs"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_key" ON "password_reset_tokens"("token");

-- CreateIndex
CREATE INDEX "password_reset_tokens_email_idx" ON "password_reset_tokens"("email");

-- CreateIndex
CREATE INDEX "password_reset_tokens_token_idx" ON "password_reset_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "login_security_states_email_key" ON "login_security_states"("email");

-- CreateIndex
CREATE INDEX "login_security_states_email_idx" ON "login_security_states"("email");

-- CreateIndex
CREATE INDEX "feedbacks_user_id_idx" ON "feedbacks"("user_id");

-- CreateIndex
CREATE INDEX "feedbacks_deleted_at_idx" ON "feedbacks"("deleted_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "feedback_events_feedback_id_created_at_idx" ON "feedback_events"("feedback_id", "created_at");

-- CreateIndex
CREATE INDEX "feedback_comments_feedback_id_created_at_idx" ON "feedback_comments"("feedback_id", "created_at");

-- CreateIndex
CREATE INDEX "feedback_comments_feedback_id_parent_comment_id_created_at_idx" ON "feedback_comments"("feedback_id", "parent_comment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "plans_name_key" ON "plans"("name");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_team_id_key" ON "subscriptions"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_stripe_invoice_id_key" ON "invoices"("stripe_invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_team_id_key" ON "billing_accounts"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_usage_team_id_key" ON "team_usage"("team_id");

-- CreateIndex
CREATE INDEX "usage_records_team_id_metric_recorded_at_idx" ON "usage_records"("team_id", "metric", "recorded_at");

-- CreateIndex
CREATE INDEX "usage_records_project_id_metric_recorded_at_idx" ON "usage_records"("project_id", "metric", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "project_usage_project_id_key" ON "project_usage"("project_id");

-- CreateIndex
CREATE INDEX "project_usage_team_id_idx" ON "project_usage"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_infrastructure_project_id_key" ON "project_infrastructure"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_infrastructure_team_id_key" ON "team_infrastructure"("team_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_trace_id_idx" ON "audit_logs"("trace_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "root_alerts_is_read_created_at_idx" ON "root_alerts"("is_read", "created_at" DESC);

-- CreateIndex
CREATE INDEX "root_alerts_kind_created_at_idx" ON "root_alerts"("kind", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "embedding_records_content_hash_key" ON "embedding_records"("content_hash");

-- CreateIndex
CREATE INDEX "embedding_records_entity_type_entity_id_idx" ON "embedding_records"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "embedding_records_project_id_entity_type_idx" ON "embedding_records"("project_id", "entity_type");

-- CreateIndex
CREATE INDEX "embedding_records_team_id_entity_type_idx" ON "embedding_records"("team_id", "entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "data_plane_provisioning_project_id_key" ON "data_plane_provisioning"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_models_project_id_name_key" ON "application_models"("project_id", "name");

-- CreateIndex
CREATE INDEX "entity_definitions_project_id_idx" ON "entity_definitions"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "entity_definitions_project_id_logical_name_key" ON "entity_definitions"("project_id", "logical_name");

-- CreateIndex
CREATE UNIQUE INDEX "entity_schema_versions_entity_definition_id_version_key" ON "entity_schema_versions"("entity_definition_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "entity_name_mappings_project_id_logical_name_key" ON "entity_name_mappings"("project_id", "logical_name");

-- CreateIndex
CREATE INDEX "data_engine_outbox_status_created_at_idx" ON "data_engine_outbox"("status", "created_at");

-- CreateIndex
CREATE INDEX "data_engine_outbox_project_id_idx" ON "data_engine_outbox"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_data_queries_project_id_name_key" ON "saved_data_queries"("project_id", "name");

-- CreateIndex
CREATE INDEX "migration_archives_project_id_status_idx" ON "migration_archives"("project_id", "status");

-- CreateIndex
CREATE INDEX "migration_archive_files_archive_id_upload_status_idx" ON "migration_archive_files"("archive_id", "upload_status");

-- CreateIndex
CREATE INDEX "migration_assessments_archive_id_assessment_version_idx" ON "migration_assessments"("archive_id", "assessment_version");

-- CreateIndex
CREATE INDEX "migration_assessments_project_id_created_at_idx" ON "migration_assessments"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "migration_restore_jobs_archive_id_status_idx" ON "migration_restore_jobs"("archive_id", "status");

-- CreateIndex
CREATE INDEX "migration_restore_jobs_source_project_id_created_at_idx" ON "migration_restore_jobs"("source_project_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "migration_import_credentials_archive_id_key" ON "migration_import_credentials"("archive_id");

-- CreateIndex
CREATE INDEX "migration_consents_archive_id_created_at_idx" ON "migration_consents"("archive_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "migration_archive_ledgers_archive_id_key" ON "migration_archive_ledgers"("archive_id");

-- CreateIndex
CREATE INDEX "invoice_line_items_invoice_id_idx" ON "invoice_line_items"("invoice_id");

-- CreateIndex
CREATE INDEX "invoice_line_items_archive_id_idx" ON "invoice_line_items"("archive_id");

-- CreateIndex
CREATE INDEX "data_structures_project_id_idx" ON "data_structures"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "data_structures_project_id_name_key" ON "data_structures"("project_id", "name");

-- CreateIndex
CREATE INDEX "data_structure_storages_data_structure_id_active_idx" ON "data_structure_storages"("data_structure_id", "active");

-- CreateIndex
CREATE INDEX "project_engine_endpoints_project_id_active_idx" ON "project_engine_endpoints"("project_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "project_engine_endpoints_project_id_engine_type_key" ON "project_engine_endpoints"("project_id", "engine_type");

-- CreateIndex
CREATE UNIQUE INDEX "provisioning_projects_project_id_key" ON "provisioning_projects"("project_id");

-- CreateIndex
CREATE INDEX "provisioning_projects_status_idx" ON "provisioning_projects"("status");

-- CreateIndex
CREATE INDEX "provisioning_resources_provisioning_project_id_status_idx" ON "provisioning_resources"("provisioning_project_id", "status");

-- CreateIndex
CREATE INDEX "provisioning_resources_provisioning_project_id_kind_idx" ON "provisioning_resources"("provisioning_project_id", "kind");

-- CreateIndex
CREATE INDEX "provisioning_operations_provisioning_project_id_status_idx" ON "provisioning_operations"("provisioning_project_id", "status");

-- CreateIndex
CREATE INDEX "provisioning_operations_resource_id_created_at_idx" ON "provisioning_operations"("resource_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "provisioning_operations_provisioning_project_id_idempotency_key" ON "provisioning_operations"("provisioning_project_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "provisioning_credential_refs_team_id_provider_idx" ON "provisioning_credential_refs"("team_id", "provider");

-- CreateIndex
CREATE INDEX "provisioning_audit_events_provisioning_project_id_created_a_idx" ON "provisioning_audit_events"("provisioning_project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "provisioning_audit_events_resource_id_created_at_idx" ON "provisioning_audit_events"("resource_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "quickbooks_sync_log_created_at_idx" ON "quickbooks_sync_log"("created_at");

-- CreateIndex
CREATE INDEX "flow_project_id_idx" ON "flow"("project_id");

-- CreateIndex
CREATE INDEX "flow_enabled_next_run_at_idx" ON "flow"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "flow_run_flow_id_idx" ON "flow_run"("flow_id");

-- CreateIndex
CREATE INDEX "flow_run_project_id_idx" ON "flow_run"("project_id");

-- CreateIndex
CREATE INDEX "blueprint_team_id_idx" ON "blueprint"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_version_blueprint_id_version_key" ON "application_version"("blueprint_id", "version");

-- CreateIndex
CREATE INDEX "migration_run_blueprint_id_idx" ON "migration_run"("blueprint_id");

-- CreateIndex
CREATE INDEX "migration_run_project_id_idx" ON "migration_run"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_api_token_token_hash_key" ON "platform_api_token"("token_hash");

-- CreateIndex
CREATE INDEX "platform_api_token_user_id_idx" ON "platform_api_token"("user_id");

-- CreateIndex
CREATE INDEX "platform_api_token_token_prefix_idx" ON "platform_api_token"("token_prefix");

-- CreateIndex
CREATE INDEX "marketing_campaign_status_idx" ON "marketing_campaign"("status");

-- CreateIndex
CREATE INDEX "marketing_campaign_created_at_idx" ON "marketing_campaign"("created_at");

-- CreateIndex
CREATE INDEX "marketing_asset_campaign_id_idx" ON "marketing_asset"("campaign_id");

-- CreateIndex
CREATE INDEX "ai_chat_sessions_user_id_team_id_updated_at_idx" ON "ai_chat_sessions"("user_id", "team_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "ai_chat_messages_session_id_created_at_idx" ON "ai_chat_messages"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "backup_verifications_project_id_started_at_idx" ON "backup_verifications"("project_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "backup_offsite_copies_project_id_created_at_idx" ON "backup_offsite_copies"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "backup_offsite_copies_kind_created_at_idx" ON "backup_offsite_copies"("kind", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "backup_offsite_copies_local_bucket_local_key_key" ON "backup_offsite_copies"("local_bucket", "local_key");

-- CreateIndex
CREATE INDEX "storage_upload_sessions_project_id_status_idx" ON "storage_upload_sessions"("project_id", "status");

-- CreateIndex
CREATE INDEX "storage_upload_sessions_expires_at_idx" ON "storage_upload_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "storage_policies_project_id_idx" ON "storage_policies"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "storage_policies_project_id_bucket_path_prefix_key" ON "storage_policies"("project_id", "bucket", "path_prefix");

-- CreateIndex
CREATE INDEX "platform_alerts_acknowledged_at_occurred_at_idx" ON "platform_alerts"("acknowledged_at", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "platform_probe_samples_probe_ts_idx" ON "platform_probe_samples"("probe", "ts");

-- CreateIndex
CREATE INDEX "platform_probe_samples_ts_idx" ON "platform_probe_samples"("ts");

-- CreateIndex
CREATE UNIQUE INDEX "platform_slo_windows_day_probe_key" ON "platform_slo_windows"("day", "probe");

-- CreateIndex
CREATE UNIQUE INDEX "platform_slo_months_month_probe_key" ON "platform_slo_months"("month", "probe");

-- CreateIndex
CREATE UNIQUE INDEX "platform_status_subscribers_email_key" ON "platform_status_subscribers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_status_subscribers_token_key" ON "platform_status_subscribers"("token");

-- CreateIndex
CREATE UNIQUE INDEX "platform_incidents_auto_key_key" ON "platform_incidents"("auto_key");

-- CreateIndex
CREATE INDEX "platform_incidents_started_at_idx" ON "platform_incidents"("started_at" DESC);

-- CreateIndex
CREATE INDEX "platform_deploy_markers_started_at_idx" ON "platform_deploy_markers"("started_at" DESC);

-- CreateIndex
CREATE INDEX "capacity_samples_ts_idx" ON "capacity_samples"("ts");

-- CreateIndex
CREATE UNIQUE INDEX "capacity_rollups_hour_key" ON "capacity_rollups"("hour");

-- CreateIndex
CREATE INDEX "capacity_model_snapshots_ts_idx" ON "capacity_model_snapshots"("ts" DESC);

-- CreateIndex
CREATE INDEX "capacity_benchmark_runs_started_at_idx" ON "capacity_benchmark_runs"("started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "project_secret_keys_key_hash_key" ON "project_secret_keys"("key_hash");

-- CreateIndex
CREATE INDEX "project_secret_keys_project_id_idx" ON "project_secret_keys"("project_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_active_team_id_fkey" FOREIGN KEY ("active_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_personal_for_user_id_fkey" FOREIGN KEY ("personal_for_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_role_permissions" ADD CONSTRAINT "team_role_permissions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "project_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_parent_project_id_fkey" FOREIGN KEY ("parent_project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_extra_roles" ADD CONSTRAINT "project_extra_roles_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "realtime_bindings" ADD CONSTRAINT "realtime_bindings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_activity_logs" ADD CONSTRAINT "project_activity_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_folders" ADD CONSTRAINT "project_folders_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_tags" ADD CONSTRAINT "project_tags_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_tag_assignments" ADD CONSTRAINT "project_tag_assignments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_tag_assignments" ADD CONSTRAINT "project_tag_assignments_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "project_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_auth_configs" ADD CONSTRAINT "project_auth_configs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_user_mfa" ADD CONSTRAINT "project_user_mfa_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imported_password_hashes" ADD CONSTRAINT "imported_password_hashes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sql_audit_logs" ADD CONSTRAINT "sql_audit_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_feedback_id_fkey" FOREIGN KEY ("feedback_id") REFERENCES "feedbacks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_comments" ADD CONSTRAINT "feedback_comments_feedback_id_fkey" FOREIGN KEY ("feedback_id") REFERENCES "feedbacks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_comments" ADD CONSTRAINT "feedback_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_comments" ADD CONSTRAINT "feedback_comments_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "feedback_comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_usage" ADD CONSTRAINT "team_usage_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_usage" ADD CONSTRAINT "project_usage_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_infrastructure" ADD CONSTRAINT "project_infrastructure_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_infrastructure" ADD CONSTRAINT "team_infrastructure_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_plane_provisioning" ADD CONSTRAINT "data_plane_provisioning_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_models" ADD CONSTRAINT "application_models_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_definitions" ADD CONSTRAINT "entity_definitions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_definitions" ADD CONSTRAINT "entity_definitions_application_model_id_fkey" FOREIGN KEY ("application_model_id") REFERENCES "application_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_schema_versions" ADD CONSTRAINT "entity_schema_versions_entity_definition_id_fkey" FOREIGN KEY ("entity_definition_id") REFERENCES "entity_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migration_archives" ADD CONSTRAINT "migration_archives_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migration_archive_files" ADD CONSTRAINT "migration_archive_files_archive_id_fkey" FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migration_assessments" ADD CONSTRAINT "migration_assessments_archive_id_fkey" FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migration_assessments" ADD CONSTRAINT "migration_assessments_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "migration_assessments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migration_restore_jobs" ADD CONSTRAINT "migration_restore_jobs_archive_id_fkey" FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migration_import_credentials" ADD CONSTRAINT "migration_import_credentials_archive_id_fkey" FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migration_consents" ADD CONSTRAINT "migration_consents_archive_id_fkey" FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migration_archive_ledgers" ADD CONSTRAINT "migration_archive_ledgers_archive_id_fkey" FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_archive_id_fkey" FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_structures" ADD CONSTRAINT "data_structures_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_structure_storages" ADD CONSTRAINT "data_structure_storages_data_structure_id_fkey" FOREIGN KEY ("data_structure_id") REFERENCES "data_structures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_structure_storages" ADD CONSTRAINT "data_structure_storages_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "project_engine_endpoints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_engine_endpoints" ADD CONSTRAINT "project_engine_endpoints_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_projects" ADD CONSTRAINT "provisioning_projects_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_projects" ADD CONSTRAINT "provisioning_projects_credential_ref_id_fkey" FOREIGN KEY ("credential_ref_id") REFERENCES "provisioning_credential_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_resources" ADD CONSTRAINT "provisioning_resources_provisioning_project_id_fkey" FOREIGN KEY ("provisioning_project_id") REFERENCES "provisioning_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_provisioning_project_id_fkey" FOREIGN KEY ("provisioning_project_id") REFERENCES "provisioning_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "provisioning_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_credential_refs" ADD CONSTRAINT "provisioning_credential_refs_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_audit_events" ADD CONSTRAINT "provisioning_audit_events_provisioning_project_id_fkey" FOREIGN KEY ("provisioning_project_id") REFERENCES "provisioning_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_audit_events" ADD CONSTRAINT "provisioning_audit_events_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "provisioning_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_audit_events" ADD CONSTRAINT "provisioning_audit_events_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "provisioning_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_run" ADD CONSTRAINT "flow_run_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_version" ADD CONSTRAINT "application_version_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_asset" ADD CONSTRAINT "marketing_asset_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "marketing_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_verifications" ADD CONSTRAINT "backup_verifications_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_secret_keys" ADD CONSTRAINT "project_secret_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

