-- Integrations schema for Kolaybase
-- Manages third-party integrations: GitHub, GitLab, KolayLabs, Vercel, KolayDeploy

CREATE TABLE IF NOT EXISTS integrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  team_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  provider VARCHAR(50) NOT NULL CHECK (provider IN ('github', 'gitlab', 'kolaylabs', 'vercel', 'kolaydeploy')),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'disconnected', 'error')),
  
  -- OAuth tokens (encrypted)
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  
  -- Provider-specific metadata
  provider_user_id VARCHAR(255),
  provider_username VARCHAR(255),
  provider_email VARCHAR(255),
  provider_avatar_url TEXT,
  
  -- Configuration
  config JSONB DEFAULT '{}'::jsonb,
  -- Example config structure:
  -- {
  --   "auto_sync": true,
  --   "repos": ["repo1", "repo2"],
  --   "permissions": ["read", "write"],
  --   "webhook_url": "...",
  --   "environments": ["dev", "staging", "prod"]
  -- }
  
  -- Sync tracking
  last_sync_at TIMESTAMPTZ,
  sync_status VARCHAR(20) DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'success', 'failed')),
  sync_error TEXT,
  
  -- Metadata
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Constraints
  UNIQUE(user_id, provider, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
);

-- Integration sync history
CREATE TABLE IF NOT EXISTS integration_sync_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
  sync_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  items_synced INTEGER DEFAULT 0,
  error_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Integration webhooks (for receiving webhooks from providers)
CREATE TABLE IF NOT EXISTS integration_webhooks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
  webhook_id VARCHAR(255),
  webhook_url TEXT NOT NULL,
  events JSONB DEFAULT '[]'::jsonb,
  secret_encrypted TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_integrations_user_id ON integrations(user_id);
CREATE INDEX IF NOT EXISTS idx_integrations_team_id ON integrations(team_id);
CREATE INDEX IF NOT EXISTS idx_integrations_project_id ON integrations(project_id);
CREATE INDEX IF NOT EXISTS idx_integrations_provider ON integrations(provider);
CREATE INDEX IF NOT EXISTS idx_integrations_status ON integrations(status);
CREATE INDEX IF NOT EXISTS idx_integration_sync_logs_integration_id ON integration_sync_logs(integration_id);
CREATE INDEX IF NOT EXISTS idx_integration_webhooks_integration_id ON integration_webhooks(integration_id);

