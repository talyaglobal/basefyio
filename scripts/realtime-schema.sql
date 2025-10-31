-- Realtime functionality schema for Kolaybase

-- Realtime channels table
CREATE TABLE IF NOT EXISTS realtime_channels (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  topic VARCHAR(255) NOT NULL,
  authorized_users JSONB DEFAULT '[]'::jsonb,
  settings JSONB DEFAULT '{
    "presence_enabled": true,
    "broadcast_enabled": true,
    "postgres_changes_enabled": true
  }'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

-- Realtime subscriptions tracking
CREATE TABLE IF NOT EXISTS realtime_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id VARCHAR(255) REFERENCES realtime_channels(id),
  user_id UUID REFERENCES users(id),
  table_name VARCHAR(255),
  schema_name VARCHAR(255) DEFAULT 'public',
  filters JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

-- Realtime presence tracking
CREATE TABLE IF NOT EXISTS realtime_presence (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id VARCHAR(255) REFERENCES realtime_channels(id),
  user_id UUID REFERENCES users(id),
  state JSONB DEFAULT '{}'::jsonb,
  online_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

-- Edge functions table
CREATE TABLE IF NOT EXISTS edge_functions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  runtime VARCHAR(50) DEFAULT 'deno' CHECK (runtime IN ('deno', 'node')),
  source_code TEXT NOT NULL,
  environment_variables JSONB DEFAULT '{}'::jsonb,
  timeout_ms INTEGER DEFAULT 30000,
  memory_limit_mb INTEGER DEFAULT 128,
  is_active BOOLEAN DEFAULT TRUE,
  version INTEGER DEFAULT 1,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deployed_at TIMESTAMPTZ
);

-- Edge function invocations log
CREATE TABLE IF NOT EXISTS edge_function_invocations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  function_id UUID REFERENCES edge_functions(id),
  execution_time_ms INTEGER,
  memory_used_mb INTEGER,
  status VARCHAR(20) DEFAULT 'success' CHECK (status IN ('success', 'error', 'timeout')),
  request_size_bytes INTEGER,
  response_size_bytes INTEGER,
  error_message TEXT,
  logs TEXT,
  invoked_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scheduled jobs table
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  cron_expression VARCHAR(255) NOT NULL,
  function_id UUID REFERENCES edge_functions(id),
  webhook_url TEXT,
  payload JSONB DEFAULT '{}'::jsonb,
  timezone VARCHAR(50) DEFAULT 'UTC',
  is_active BOOLEAN DEFAULT TRUE,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_run_status VARCHAR(20) CHECK (last_run_status IN ('success', 'error', 'timeout')),
  last_error_message TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scheduled job execution history
CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID REFERENCES scheduled_jobs(id),
  status VARCHAR(20) DEFAULT 'running' CHECK (status IN ('running', 'success', 'error', 'timeout')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  execution_time_ms INTEGER,
  output TEXT,
  error_message TEXT,
  logs TEXT
);

-- Secrets manager table
CREATE TABLE IF NOT EXISTS secrets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  encrypted_value TEXT NOT NULL,
  key_id VARCHAR(255) NOT NULL, -- For key rotation
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER DEFAULT 0,
  UNIQUE(name)
);

-- Secret access permissions
CREATE TABLE IF NOT EXISTS secret_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  secret_id UUID REFERENCES secrets(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  function_id UUID REFERENCES edge_functions(id),
  permission VARCHAR(20) DEFAULT 'read' CHECK (permission IN ('read', 'write', 'admin')),
  granted_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE(secret_id, user_id),
  UNIQUE(secret_id, function_id)
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_realtime_channels_topic ON realtime_channels(topic);
CREATE INDEX IF NOT EXISTS idx_realtime_subscriptions_channel ON realtime_subscriptions(channel_id);
CREATE INDEX IF NOT EXISTS idx_realtime_subscriptions_user ON realtime_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_realtime_presence_channel ON realtime_presence(channel_id);
CREATE INDEX IF NOT EXISTS idx_realtime_presence_user ON realtime_presence(user_id);
CREATE INDEX IF NOT EXISTS idx_edge_functions_slug ON edge_functions(slug);
CREATE INDEX IF NOT EXISTS idx_edge_function_invocations_function ON edge_function_invocations(function_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_next_run ON scheduled_jobs(next_run_at) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job ON scheduled_job_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_secrets_name ON secrets(name);
CREATE INDEX IF NOT EXISTS idx_secret_permissions_secret ON secret_permissions(secret_id);

-- Enable row level security
ALTER TABLE realtime_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_functions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;

-- Create policies for realtime channels
CREATE POLICY "Users can view public channels" ON realtime_channels
  FOR SELECT USING (
    authorized_users IS NULL OR 
    jsonb_array_length(authorized_users) = 0 OR
    authorized_users ? current_setting('app.current_user_id', true)
  );

-- Create policies for secrets (strict access control)
CREATE POLICY "Users can only access their own secrets" ON secrets
  FOR ALL USING (created_by::text = current_setting('app.current_user_id', true));

-- Functions for updating timestamps
CREATE TRIGGER update_realtime_channels_updated_at 
  BEFORE UPDATE ON realtime_channels 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_edge_functions_updated_at 
  BEFORE UPDATE ON edge_functions 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_scheduled_jobs_updated_at 
  BEFORE UPDATE ON scheduled_jobs 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_secrets_updated_at 
  BEFORE UPDATE ON secrets 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();