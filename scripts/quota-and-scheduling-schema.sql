-- Quota Monitoring and Scheduling Database Schema
-- Additional tables required for quota monitoring, scheduling, and advanced features

-- Enable required extensions (in case they're not already enabled)
-- Note: Using gen_random_uuid() which is available in PostgreSQL 13+ without extensions
-- CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =======================
-- QUOTA MONITORING TABLES
-- =======================

-- Resource usage tracking table
CREATE TABLE IF NOT EXISTS resource_usage_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  resource_type VARCHAR(50) NOT NULL, -- 'api_calls', 'storage', 'bandwidth', etc.
  usage_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  unit VARCHAR(20) NOT NULL, -- 'bytes', 'count', 'requests', etc.
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb,
  CONSTRAINT check_usage_amount CHECK (usage_amount >= 0)
);

-- Quota thresholds configuration
CREATE TABLE IF NOT EXISTS quota_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  resource_type VARCHAR(50) NOT NULL,
  threshold_type VARCHAR(20) NOT NULL CHECK (threshold_type IN ('warning', 'critical', 'limit')),
  threshold_value NUMERIC(15,2) NOT NULL,
  unit VARCHAR(20) NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, resource_type, threshold_type)
);

-- Quota violations tracking
CREATE TABLE IF NOT EXISTS quota_violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  resource_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  threshold_exceeded NUMERIC(15,2) NOT NULL,
  actual_usage NUMERIC(15,2) NOT NULL,
  unit VARCHAR(20) NOT NULL,
  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Alert channels for quota notifications
CREATE TABLE IF NOT EXISTS quota_alert_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('email', 'webhook', 'sms', 'slack')),
  config JSONB NOT NULL, -- Channel-specific configuration
  enabled BOOLEAN DEFAULT TRUE,
  events TEXT[] NOT NULL DEFAULT '{quota_warning,quota_critical,quota_exceeded}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =======================
-- SCHEDULING TABLES
-- =======================

-- Scheduled jobs configuration
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  cron_expression VARCHAR(100) NOT NULL,
  function_id UUID, -- References edge_functions(id)
  webhook_url TEXT,
  payload JSONB DEFAULT '{}'::jsonb,
  timezone VARCHAR(50) DEFAULT 'UTC',
  is_active BOOLEAN DEFAULT TRUE,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  run_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  max_failures INTEGER DEFAULT 3,
  timeout_seconds INTEGER DEFAULT 300,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scheduled job execution history
CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'timeout')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  output TEXT,
  error TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  retry_attempt INTEGER DEFAULT 0
);

-- =======================
-- EDGE FUNCTIONS TABLES
-- =======================

-- Edge functions configuration
CREATE TABLE IF NOT EXISTS edge_functions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  source_code TEXT NOT NULL,
  runtime VARCHAR(20) DEFAULT 'node18' CHECK (runtime IN ('node16', 'node18', 'python3.9', 'deno')),
  environment_variables JSONB DEFAULT '{}'::jsonb,
  is_active BOOLEAN DEFAULT TRUE,
  timeout_seconds INTEGER DEFAULT 60,
  memory_limit_mb INTEGER DEFAULT 256,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

-- Edge function invocation logs
CREATE TABLE IF NOT EXISTS edge_function_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id UUID REFERENCES edge_functions(id) ON DELETE CASCADE,
  request_id VARCHAR(100),
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'timeout')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  memory_used_mb INTEGER,
  input JSONB,
  output TEXT,
  error TEXT,
  logs TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- =======================
-- SECRETS MANAGEMENT TABLES
-- =======================

-- Encryption keys for secrets management
CREATE TABLE IF NOT EXISTS encryption_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id VARCHAR(100) UNIQUE NOT NULL,
  encrypted_key TEXT NOT NULL, -- Key encrypted with master key
  algorithm VARCHAR(50) DEFAULT 'AES-256-GCM',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  rotated_at TIMESTAMPTZ
);

-- Secrets storage
CREATE TABLE IF NOT EXISTS secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  encrypted_value TEXT NOT NULL,
  key_id UUID REFERENCES encryption_keys(id),
  created_by UUID REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  tags JSONB DEFAULT '[]'::jsonb,
  access_count INTEGER DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

-- =======================
-- REALTIME & SYSTEM TABLES
-- =======================

-- Realtime channels
CREATE TABLE IF NOT EXISTS realtime_channels (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  topic VARCHAR(255) NOT NULL,
  settings JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Database backups metadata
CREATE TABLE IF NOT EXISTS database_backups (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  size BIGINT DEFAULT 0,
  type VARCHAR(20) DEFAULT 'manual' CHECK (type IN ('manual', 'scheduled', 'pitr')),
  status VARCHAR(20) DEFAULT 'creating' CHECK (status IN ('creating', 'completed', 'failed', 'deleted')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  retain_until TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- System-wide configuration
CREATE TABLE IF NOT EXISTS system_config (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =======================
-- ADDITIONAL FEATURES TABLES
-- =======================

-- User subscription/plan information
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR(20) DEFAULT 'free' CHECK (subscription_tier IN ('free', 'starter', 'pro', 'enterprise'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;

-- Update API keys table with missing column
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS hashed_key TEXT;
UPDATE api_keys SET hashed_key = key_hash WHERE hashed_key IS NULL AND key_hash IS NOT NULL;

-- =======================
-- INDEXES FOR PERFORMANCE
-- =======================

-- Resource usage indexes
CREATE INDEX IF NOT EXISTS idx_resource_usage_log_user_id ON resource_usage_log(user_id);
CREATE INDEX IF NOT EXISTS idx_resource_usage_log_timestamp ON resource_usage_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_resource_usage_log_resource_type ON resource_usage_log(resource_type);
CREATE INDEX IF NOT EXISTS idx_resource_usage_log_user_resource_time ON resource_usage_log(user_id, resource_type, timestamp);

-- Quota monitoring indexes
CREATE INDEX IF NOT EXISTS idx_quota_thresholds_user_id ON quota_thresholds(user_id);
CREATE INDEX IF NOT EXISTS idx_quota_violations_user_id ON quota_violations(user_id);
CREATE INDEX IF NOT EXISTS idx_quota_violations_severity ON quota_violations(severity);
CREATE INDEX IF NOT EXISTS idx_quota_violations_acknowledged ON quota_violations(acknowledged);
CREATE INDEX IF NOT EXISTS idx_quota_alert_channels_user_id ON quota_alert_channels(user_id);

-- Scheduling indexes  
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_user_id ON scheduled_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_is_active ON scheduled_jobs(is_active);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_next_run_at ON scheduled_jobs(next_run_at) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job_id ON scheduled_job_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_started_at ON scheduled_job_runs(started_at);

-- Edge functions indexes
CREATE INDEX IF NOT EXISTS idx_edge_functions_user_id ON edge_functions(user_id);
CREATE INDEX IF NOT EXISTS idx_edge_functions_is_active ON edge_functions(is_active);
CREATE INDEX IF NOT EXISTS idx_edge_function_invocations_function_id ON edge_function_invocations(function_id);
CREATE INDEX IF NOT EXISTS idx_edge_function_invocations_started_at ON edge_function_invocations(started_at);

-- Secrets indexes
CREATE INDEX IF NOT EXISTS idx_secrets_user_id ON secrets(user_id);
CREATE INDEX IF NOT EXISTS idx_secrets_expires_at ON secrets(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_encryption_keys_key_id ON encryption_keys(key_id);
CREATE INDEX IF NOT EXISTS idx_encryption_keys_is_active ON encryption_keys(is_active);

-- =======================
-- TRIGGERS FOR UPDATED_AT
-- =======================

-- Quota thresholds
CREATE TRIGGER IF NOT EXISTS update_quota_thresholds_updated_at 
  BEFORE UPDATE ON quota_thresholds 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Alert channels
CREATE TRIGGER IF NOT EXISTS update_quota_alert_channels_updated_at 
  BEFORE UPDATE ON quota_alert_channels 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Scheduled jobs
CREATE TRIGGER IF NOT EXISTS update_scheduled_jobs_updated_at 
  BEFORE UPDATE ON scheduled_jobs 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Edge functions
CREATE TRIGGER IF NOT EXISTS update_edge_functions_updated_at 
  BEFORE UPDATE ON edge_functions 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Secrets
CREATE TRIGGER IF NOT EXISTS update_secrets_updated_at 
  BEFORE UPDATE ON secrets 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- System config
CREATE TRIGGER IF NOT EXISTS update_system_config_updated_at 
  BEFORE UPDATE ON system_config 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =======================
-- DEFAULT CONFIGURATION DATA
-- =======================

-- Insert default system configuration
INSERT INTO system_config (key, value, description) VALUES 
  ('quota_check_interval_minutes', '5'::jsonb, 'How often to check resource quotas (in minutes)'),
  ('max_api_calls_per_hour', '1000'::jsonb, 'Default API calls limit per hour for free tier'),
  ('max_storage_mb', '100'::jsonb, 'Default storage limit in MB for free tier'),
  ('scheduler_enabled', 'true'::jsonb, 'Whether the job scheduler is enabled'),
  ('edge_functions_enabled', 'true'::jsonb, 'Whether edge functions are enabled'),
  ('secrets_encryption_algorithm', '"AES-256-GCM"'::jsonb, 'Default encryption algorithm for secrets')
ON CONFLICT (key) DO NOTHING;

-- Insert default encryption key (this should be properly generated in production)
INSERT INTO encryption_keys (key_id, encrypted_key, algorithm) VALUES 
  ('default', 'replace_with_properly_encrypted_key_in_production', 'AES-256-GCM')
ON CONFLICT (key_id) DO NOTHING;

-- Insert default quota thresholds for existing users (if any)
INSERT INTO quota_thresholds (user_id, resource_type, threshold_type, threshold_value, unit)
SELECT 
  id as user_id,
  'api_calls' as resource_type,
  threshold_type,
  threshold_value,
  'count' as unit
FROM users,
LATERAL (VALUES 
  ('warning', 800),
  ('critical', 950),
  ('limit', 1000)
) AS t(threshold_type, threshold_value)
WHERE NOT EXISTS (
  SELECT 1 FROM quota_thresholds qt 
  WHERE qt.user_id = users.id 
  AND qt.resource_type = 'api_calls' 
  AND qt.threshold_type = t.threshold_type
);