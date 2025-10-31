-- Quota Violations Table
CREATE TABLE IF NOT EXISTS quota_violations (
    id VARCHAR(255) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource VARCHAR(50) NOT NULL, -- 'database', 'storage', 'api', 'backup'
    violation_type VARCHAR(50) NOT NULL, -- 'threshold', 'limit_exceeded', 'near_limit'
    current_usage BIGINT NOT NULL,
    quota_limit BIGINT NOT NULL,
    utilization_percent DECIMAL(5,2) NOT NULL,
    severity VARCHAR(20) NOT NULL, -- 'low', 'medium', 'high', 'critical'
    message TEXT NOT NULL,
    acknowledged BOOLEAN DEFAULT FALSE,
    acknowledged_at TIMESTAMP,
    acknowledged_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Quota Thresholds Table
CREATE TABLE IF NOT EXISTS quota_thresholds (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource VARCHAR(50) NOT NULL, -- 'database', 'storage', 'api', 'backup'
    metric VARCHAR(50) NOT NULL, -- 'size', 'tables', 'connections', etc.
    warning_threshold INTEGER NOT NULL, -- percentage (0-100)
    critical_threshold INTEGER NOT NULL, -- percentage (0-100)
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, resource, metric)
);

-- Quota Alert Channels Table
CREATE TABLE IF NOT EXISTS quota_alert_channels (
    id VARCHAR(255) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL, -- 'webhook', 'email', 'slack'
    config JSONB NOT NULL, -- channel-specific configuration
    enabled BOOLEAN DEFAULT TRUE,
    events JSONB NOT NULL, -- array of event types to subscribe to
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Quota Alert History Table
CREATE TABLE IF NOT EXISTS quota_alert_history (
    id SERIAL PRIMARY KEY,
    channel_id VARCHAR(255) NOT NULL REFERENCES quota_alert_channels(id) ON DELETE CASCADE,
    violation_ids JSONB NOT NULL, -- array of violation IDs that triggered this alert
    status VARCHAR(20) NOT NULL, -- 'sent', 'failed', 'pending'
    response_code INTEGER, -- HTTP response code for webhooks
    error_message TEXT,
    sent_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_quota_violations_user_id ON quota_violations(user_id);
CREATE INDEX IF NOT EXISTS idx_quota_violations_created_at ON quota_violations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quota_violations_severity ON quota_violations(severity);
CREATE INDEX IF NOT EXISTS idx_quota_violations_acknowledged ON quota_violations(acknowledged);
CREATE INDEX IF NOT EXISTS idx_quota_violations_resource ON quota_violations(resource);

CREATE INDEX IF NOT EXISTS idx_quota_thresholds_user_id ON quota_thresholds(user_id);
CREATE INDEX IF NOT EXISTS idx_quota_thresholds_enabled ON quota_thresholds(enabled);

CREATE INDEX IF NOT EXISTS idx_quota_alert_channels_user_id ON quota_alert_channels(user_id);
CREATE INDEX IF NOT EXISTS idx_quota_alert_channels_enabled ON quota_alert_channels(enabled);

CREATE INDEX IF NOT EXISTS idx_quota_alert_history_channel_id ON quota_alert_history(channel_id);
CREATE INDEX IF NOT EXISTS idx_quota_alert_history_created_at ON quota_alert_history(created_at DESC);

-- Trigger to update updated_at column
CREATE OR REPLACE FUNCTION update_quota_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_quota_violations_updated_at BEFORE UPDATE ON quota_violations
    FOR EACH ROW EXECUTE FUNCTION update_quota_updated_at_column();

CREATE TRIGGER update_quota_thresholds_updated_at BEFORE UPDATE ON quota_thresholds
    FOR EACH ROW EXECUTE FUNCTION update_quota_updated_at_column();

CREATE TRIGGER update_quota_alert_channels_updated_at BEFORE UPDATE ON quota_alert_channels
    FOR EACH ROW EXECUTE FUNCTION update_quota_updated_at_column();

-- Add constraints
ALTER TABLE quota_thresholds 
ADD CONSTRAINT check_warning_threshold_range CHECK (warning_threshold >= 0 AND warning_threshold <= 100);

ALTER TABLE quota_thresholds 
ADD CONSTRAINT check_critical_threshold_range CHECK (critical_threshold >= 0 AND critical_threshold <= 100);

ALTER TABLE quota_thresholds 
ADD CONSTRAINT check_thresholds_order CHECK (critical_threshold >= warning_threshold);

-- Comments for documentation
COMMENT ON TABLE quota_violations IS 'Stores detected quota violations and their details';
COMMENT ON TABLE quota_thresholds IS 'User-configurable thresholds for quota monitoring';
COMMENT ON TABLE quota_alert_channels IS 'Configuration for different alert delivery channels';
COMMENT ON TABLE quota_alert_history IS 'History of sent alerts for auditing purposes';

COMMENT ON COLUMN quota_violations.utilization_percent IS 'Percentage of quota being used (can exceed 100%)';
COMMENT ON COLUMN quota_violations.severity IS 'Severity level based on threshold configuration';
COMMENT ON COLUMN quota_thresholds.warning_threshold IS 'Percentage that triggers a warning alert';
COMMENT ON COLUMN quota_thresholds.critical_threshold IS 'Percentage that triggers a critical alert';
COMMENT ON COLUMN quota_alert_channels.config IS 'JSON configuration specific to the channel type';
COMMENT ON COLUMN quota_alert_channels.events IS 'Array of event types this channel subscribes to';