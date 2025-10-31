# Database Schema Documentation

This document describes the complete database schema for Kolaybase, including the new quota monitoring and scheduling features.

## Setup Instructions

### New Installation
For new installations, run the complete setup:
```bash
node scripts/setup-db.js
```

### Existing Installation
If you already have Kolaybase set up, add the new features:
```bash
node scripts/add-quota-scheduling.js
```

## Core Tables

### Users & Organizations
- `users` - User accounts with subscription tiers
- `organizations` - Organization/team management
- `organization_memberships` - User-organization relationships
- `projects` - Database projects within organizations

### API Management
- `api_keys` - API key management with scopes
- `saved_queries` - User-saved SQL queries
- `webhooks` - Webhook configurations

### Storage
- `storage_buckets` - File storage bucket configuration
- `storage_files` - File metadata and organization

### Security
- `rls_policies` - Row-level security policy tracking

## New Feature Tables

### 📊 Quota Monitoring

#### `resource_usage_log`
Tracks resource consumption over time.
```sql
- user_id: User who consumed the resource
- resource_type: 'api_calls', 'storage', 'bandwidth', etc.
- usage_amount: Amount consumed
- unit: 'bytes', 'count', 'requests', etc.
- timestamp: When the usage occurred
- metadata: Additional context (JSON)
```

#### `quota_thresholds`
Configuration for quota limits and warnings.
```sql
- user_id: User the threshold applies to
- resource_type: Type of resource
- threshold_type: 'warning', 'critical', or 'limit'
- threshold_value: Numeric threshold
- unit: Unit of measurement
```

#### `quota_violations`
Records when quotas are exceeded.
```sql
- user_id: User who exceeded quota
- resource_type: Type of resource exceeded
- severity: 'low', 'medium', 'high', 'critical'
- threshold_exceeded: Which threshold was crossed
- actual_usage: How much was actually used
- acknowledged: Whether violation was acknowledged
```

#### `quota_alert_channels`
Configuration for quota notifications.
```sql
- user_id: User the alert channel belongs to
- type: 'email', 'webhook', 'sms', 'slack'
- config: Channel-specific settings (JSON)
- events: Which events trigger alerts
```

### 📅 Scheduling

#### `scheduled_jobs`
Cron job configurations.
```sql
- user_id: Job owner
- name: Human-readable job name
- cron_expression: Cron schedule expression
- function_id: Edge function to execute (optional)
- webhook_url: HTTP endpoint to call (optional)
- payload: Data to send (JSON)
- timezone: Timezone for scheduling
- is_active: Whether job is enabled
- next_run_at: Next scheduled execution
- failure_count: Number of consecutive failures
- max_failures: Max failures before disabling
```

#### `scheduled_job_runs`
Execution history for scheduled jobs.
```sql
- job_id: Which job this execution belongs to
- status: 'pending', 'running', 'completed', 'failed', etc.
- started_at: When execution began
- completed_at: When execution finished
- duration_ms: How long execution took
- output: Job output/response
- error: Error message if failed
```

### ⚡ Edge Functions

#### `edge_functions`
Serverless function definitions.
```sql
- user_id: Function owner
- name: Function name
- source_code: Function implementation
- runtime: 'node18', 'python3.9', 'deno'
- environment_variables: Runtime environment (JSON)
- timeout_seconds: Maximum execution time
- memory_limit_mb: Memory allocation
```

#### `edge_function_invocations`
Function execution logs.
```sql
- function_id: Which function was invoked
- request_id: Unique request identifier
- status: Execution status
- duration_ms: Execution time
- memory_used_mb: Memory consumption
- input: Function input data (JSON)
- output: Function return value
- logs: Console output
```

### 🔐 Secrets Management

#### `encryption_keys`
Encryption key management.
```sql
- key_id: Unique key identifier
- encrypted_key: Key encrypted with master key
- algorithm: Encryption algorithm used
- is_active: Whether key is currently active
```

#### `secrets`
Encrypted secret storage.
```sql
- user_id: Secret owner
- name: Secret name/identifier
- encrypted_value: Encrypted secret data
- key_id: Which encryption key was used
- expires_at: Optional expiration time
- access_count: Number of times accessed
```

### 🔄 System Tables

#### `realtime_channels`
Real-time communication channels.

#### `database_backups`
Backup metadata and status.

#### `system_config`
System-wide configuration key-value pairs.

## Default Configuration

### System Config
The following default configurations are set:
- `quota_check_interval_minutes`: 5 (how often to check quotas)
- `max_api_calls_per_hour`: 1000 (default API limit for free tier)
- `max_storage_mb`: 100 (default storage limit for free tier)
- `scheduler_enabled`: true (enable job scheduling)
- `edge_functions_enabled`: true (enable serverless functions)

### Default Quotas
All users automatically get default quota thresholds:
- API Calls: 800 (warning), 950 (critical), 1000 (limit)

## Indexes

Comprehensive indexes are created for:
- User lookups across all tables
- Time-based queries (timestamps, scheduling)
- Resource type filtering
- Status-based filtering
- Frequently joined relationships

## Security Considerations

### Production Deployment
1. **Update default encryption keys**: Replace the default encryption key with a properly generated one
2. **Change default admin password**: The default admin user has a placeholder password
3. **Review quota thresholds**: Adjust default limits based on your pricing tiers
4. **Configure alert channels**: Set up proper notification channels
5. **Monitor resource usage**: Regular cleanup of old logs and execution history

### Environment Variables Required
```bash
DATABASE_URL=postgresql://user:password@localhost:5432/kolaybase
ENCRYPTION_MASTER_KEY=your-256-bit-master-key-here
```

## Maintenance

### Regular Cleanup Queries
```sql
-- Clean old resource usage logs (older than 30 days)
DELETE FROM resource_usage_log 
WHERE timestamp < NOW() - INTERVAL '30 days';

-- Clean old job execution history (older than 7 days)
DELETE FROM scheduled_job_runs 
WHERE started_at < NOW() - INTERVAL '7 days';

-- Clean old function invocation logs (older than 7 days)
DELETE FROM edge_function_invocations 
WHERE started_at < NOW() - INTERVAL '7 days';
```

### Monitoring Queries
```sql
-- Check quota violations
SELECT user_id, resource_type, severity, COUNT(*) as violations
FROM quota_violations 
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY user_id, resource_type, severity;

-- Check failed jobs
SELECT name, failure_count, last_run_at
FROM scheduled_jobs 
WHERE failure_count > 0 AND is_active = true;

-- Check resource usage trends
SELECT 
  resource_type,
  DATE_TRUNC('day', timestamp) as day,
  SUM(usage_amount) as total_usage
FROM resource_usage_log 
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY resource_type, day
ORDER BY day DESC;
```

## API Integration

The new tables are integrated with the following API endpoints:
- `/api/quotas/*` - Quota management and monitoring
- `/api/scheduled-jobs/*` - Job scheduling and management  
- `/api/edge-functions/*` - Serverless function management
- `/api/secrets/*` - Secret storage and retrieval
- `/api/system/config/*` - System configuration management

See the corresponding TypeScript interfaces in the `lib/` directory for detailed API schemas.