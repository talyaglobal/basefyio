# Quota Monitoring & Alerting System

A comprehensive resource quota monitoring and alerting system for Kolaybase that automatically tracks resource usage and sends alerts when thresholds are exceeded.

## Features

### 🔍 Resource Monitoring
- **Database**: Size, table count, active connections, query performance
- **Storage**: File storage size, file count, largest file size  
- **API**: Hourly/daily request limits, concurrent request limits
- **Backup**: Backup count, total backup storage size

### ⚠️ Violation Detection
- **Configurable Thresholds**: Set warning (default 80%) and critical (default 95%) thresholds
- **Severity Levels**: Low, Medium, High, Critical based on utilization percentage
- **Real-time Detection**: Automatic monitoring every 5 minutes via scheduled job

### 🚨 Alert Channels
- **Webhook**: HTTP POST to custom endpoints with violation data
- **Email**: Email notifications (integration required)
- **Slack**: Slack channel notifications (integration required)

### 📊 Dashboard
- Visual quota usage overview
- Active violation list with severity indicators
- Violation acknowledgment system
- Historical violation tracking

## Quick Start

### 1. Database Setup

Run the quota monitoring migration:

```bash
# Apply the quota monitoring database schema
npm run migrate -- 005_quota_monitoring.sql
```

### 2. Initialize Monitoring

The quota monitor automatically initializes when the application starts and creates a scheduled job that runs every 5 minutes.

### 3. Access Dashboard

Navigate to `/dashboard/quota-monitor` to view the quota monitoring dashboard.

## API Endpoints

### Monitor Status
```http
GET /api/quotas/monitor
```
Get current quota status and violations for authenticated user.

```http
POST /api/quotas/monitor
```
Manually trigger quota monitoring (admin only).

### Violations
```http
GET /api/quotas/violations?limit=50&severity=critical
```
List quota violations with optional filtering.

```http
POST /api/quotas/violations/{id}/acknowledge
```
Acknowledge a specific violation.

### Alert Channels
```http
GET /api/quotas/alerts
POST /api/quotas/alerts
```
Manage alert delivery channels.

### Thresholds
```http
GET /api/quotas/thresholds
PUT /api/quotas/thresholds
```
Get and update quota monitoring thresholds.

## Configuration

### Default Thresholds

| Resource | Metric | Warning | Critical |
|----------|--------|---------|----------|
| Database | Size | 80% | 95% |
| Database | Tables | 80% | 90% |
| Database | Connections | 70% | 90% |
| Storage | Size | 80% | 95% |
| Storage | Files | 80% | 90% |
| API | Requests/Hour | 85% | 95% |
| API | Requests/Day | 85% | 95% |
| API | Concurrent | 80% | 90% |
| Backup | Count | 80% | 90% |
| Backup | Size | 80% | 95% |

### Custom Thresholds

Update thresholds for a user:

```typescript
import { quotaMonitor } from '@/lib/quota-monitor'

await quotaMonitor.updateUserThresholds(userId, [
  {
    resource: 'database',
    metric: 'size',
    warningThreshold: 70,
    criticalThreshold: 85,
    enabled: true
  }
])
```

### Alert Channels

Create a webhook alert channel:

```typescript
await quotaMonitor.createAlertChannel(userId, {
  type: 'webhook',
  config: {
    url: 'https://your-webhook.example.com/alerts',
    headers: {
      'Authorization': 'Bearer your-token'
    }
  },
  events: ['quota_warning', 'quota_critical', 'quota_exceeded'],
  enabled: true
})
```

## Usage Examples

### Check User Quotas

```typescript
import { quotaMonitor } from '@/lib/quota-monitor'

const violations = await quotaMonitor.checkUserQuotas(userId)
console.log(`Found ${violations.length} violations`)

violations.forEach(violation => {
  console.log(`${violation.severity}: ${violation.message}`)
})
```

### Manual System-wide Check

```typescript
const allViolations = await quotaMonitor.checkAllUserQuotas()
console.log(`System-wide violations: ${allViolations.length}`)
```

### Acknowledge Violation

```typescript
await quotaMonitor.acknowledgeViolation(violationId, userId, adminUserId)
```

### Get Violations History

```typescript
const history = await quotaMonitor.getViolationsHistory(userId, 50, 'critical')
```

## Database Schema

### Tables Created

- `quota_violations`: Stores detected quota violations
- `quota_thresholds`: User-configurable monitoring thresholds  
- `quota_alert_channels`: Alert delivery channel configurations
- `quota_alert_history`: History of sent alerts for auditing

### Indexes

Performance-optimized indexes on:
- User ID lookups
- Severity filtering
- Timestamp ordering
- Resource type filtering

## Testing

Run the test suite to verify functionality:

```bash
npm run tsx scripts/test-quota-monitor.ts
```

The test script covers:
- Quota violation detection
- Alert channel creation
- Threshold configuration
- Violation acknowledgment
- System-wide monitoring

## Integration

### Webhook Payload

When a violation occurs, webhooks receive:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "userId": "user-123",
  "violations": [
    {
      "resource": "database",
      "severity": "high", 
      "message": "Database size at 92.5% of quota (463MB/512MB)",
      "utilizationPercent": 92.5,
      "timestamp": "2024-01-15T10:30:00Z"
    }
  ],
  "summary": "Quota Alert: 1 violation(s) detected (1 high)"
}
```

### Rate Limiting

- Duplicate violations within 1 hour are deduplicated
- Alert channels respect user configuration
- Monitoring runs every 5 minutes to balance accuracy and performance

## Troubleshooting

### Common Issues

1. **No violations detected**: Check if users have data and are within thresholds
2. **Alerts not sending**: Verify webhook URLs are accessible and alert channels are enabled
3. **Performance issues**: Monitor database query performance, especially for large user bases

### Debug Mode

Enable debug logging:

```bash
DEBUG=quota-monitor npm start
```

### Manual Trigger

Manually trigger monitoring via API:

```bash
curl -X POST /api/quotas/monitor \
  -H "Authorization: Bearer admin-token"
```

## Architecture

### Components

- **QuotaMonitor**: Core monitoring logic and violation detection
- **JobScheduler**: Handles scheduled monitoring jobs  
- **ResourceQuotaManager**: Manages quota limits and usage calculation
- **Alert System**: Multi-channel alert delivery

### Data Flow

1. Scheduled job triggers quota monitoring every 5 minutes
2. System checks all active users' resource usage
3. Violations are detected by comparing usage to thresholds
4. New violations are stored and alerts are triggered
5. Alert channels deliver notifications based on user preferences

### Performance Considerations

- Monitoring runs asynchronously to avoid blocking application
- Database queries are optimized with proper indexing
- Duplicate violation detection prevents alert spam
- Alert delivery is fault-tolerant with retry logic

## Security

- All API endpoints require appropriate scopes
- Webhook URLs are validated before storage
- User data is isolated per tenant
- Alert history provides audit trail
- Sensitive configuration is encrypted at rest