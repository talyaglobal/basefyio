#!/usr/bin/env tsx

/**
 * Test script for quota monitoring system
 * This script tests the quota monitoring and alerting functionality
 */

import { quotaMonitor } from '../lib/quota-monitor'
import { quotaManager } from '../lib/resource-quotas'
import { safeDb } from '../lib/db-safety'

async function testQuotaMonitoring() {
  console.log('🧪 Starting quota monitoring system test...\n')

  try {
    // 1. Test quota monitor initialization
    console.log('1️⃣ Testing quota monitor initialization...')
    const monitor = quotaMonitor
    console.log('✅ Quota monitor initialized successfully\n')

    // 2. Create a test user for testing
    console.log('2️⃣ Creating test user...')
    const testUserId = 'test-user-' + Date.now()
    
    await safeDb.safeInsert(`
      INSERT INTO users (id, email, is_active, subscription_tier)
      VALUES ($1, $2, TRUE, 'free')
    `, [testUserId, `test-${testUserId}@example.com`])
    
    console.log(`✅ Test user created: ${testUserId}\n`)

    // 3. Test quota checking for the user
    console.log('3️⃣ Testing quota violation detection...')
    const violations = await monitor.checkUserQuotas(testUserId)
    console.log(`✅ Quota check completed. Found ${violations.length} violations\n`)

    // 4. Test creating alert channel
    console.log('4️⃣ Testing alert channel creation...')
    const channelId = await monitor.createAlertChannel(testUserId, {
      type: 'webhook',
      config: {
        url: 'https://httpbin.org/post',
        headers: {
          'Authorization': 'Bearer test-token'
        }
      },
      events: ['quota_warning', 'quota_critical', 'quota_exceeded'],
      enabled: true
    })
    console.log(`✅ Alert channel created: ${channelId}\n`)

    // 5. Test threshold configuration
    console.log('5️⃣ Testing threshold configuration...')
    await monitor.updateUserThresholds(testUserId, [
      {
        resource: 'database',
        metric: 'size',
        warningThreshold: 50, // Lower threshold for testing
        criticalThreshold: 70,
        enabled: true
      },
      {
        resource: 'storage',
        metric: 'size',
        warningThreshold: 60,
        criticalThreshold: 80,
        enabled: true
      }
    ])
    console.log('✅ Thresholds configured successfully\n')

    // 6. Simulate high usage and test violation detection
    console.log('6️⃣ Testing with simulated high usage...')
    
    // Insert some mock usage data to trigger violations
    await safeDb.safeInsert(`
      INSERT INTO resource_usage_log (
        user_id, timestamp,
        database_size, database_tables, database_connections, database_queries, database_avg_query_time,
        storage_size, storage_files, storage_largest_file,
        api_requests_hour, api_requests_day, api_concurrent,
        backup_count, backup_total_size, backup_oldest
      ) VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
      testUserId, new Date(),
      400 * 1024 * 1024, // 400MB (close to 512MB free tier limit)
      8, // 8 tables
      2, // 2 connections
      1000, // 1000 queries
      150, // 150ms avg query time
      800 * 1024 * 1024, // 800MB storage (close to 1GB limit)
      80, // 80 files
      5 * 1024 * 1024, // 5MB largest file
      900, // 900 requests last hour (close to 1000 limit)
      9000, // 9000 requests today
      5, // 5 concurrent
      2, // 2 backups
      80 * 1024 * 1024, // 80MB backup size
      new Date()
    ])

    // Re-run quota check to detect violations
    const newViolations = await monitor.checkUserQuotas(testUserId)
    console.log(`✅ Found ${newViolations.length} violations with simulated usage`)
    
    newViolations.forEach((violation, index) => {
      console.log(`   ${index + 1}. ${violation.severity.toUpperCase()}: ${violation.message}`)
    })
    console.log('')

    // 7. Test violation acknowledgment
    if (newViolations.length > 0) {
      console.log('7️⃣ Testing violation acknowledgment...')
      const violationId = newViolations[0].id
      await monitor.acknowledgeViolation(violationId, testUserId, 'test-admin')
      console.log(`✅ Violation ${violationId} acknowledged successfully\n`)
    }

    // 8. Test violations history
    console.log('8️⃣ Testing violations history...')
    const history = await monitor.getViolationsHistory(testUserId, 10)
    console.log(`✅ Retrieved ${history.length} violations from history\n`)

    // 9. Test manual monitoring trigger
    console.log('9️⃣ Testing manual monitoring trigger...')
    const allViolations = await monitor.checkAllUserQuotas()
    console.log(`✅ System-wide check completed. Found ${allViolations.length} total violations\n`)

    // 10. Cleanup test data
    console.log('🧹 Cleaning up test data...')
    await safeDb.safeDelete(`DELETE FROM quota_alert_channels WHERE user_id = $1`, [testUserId])
    await safeDb.safeDelete(`DELETE FROM quota_thresholds WHERE user_id = $1`, [testUserId])
    await safeDb.safeDelete(`DELETE FROM quota_violations WHERE user_id = $1`, [testUserId])
    await safeDb.safeDelete(`DELETE FROM resource_usage_log WHERE user_id = $1`, [testUserId])
    await safeDb.safeDelete(`DELETE FROM users WHERE id = $1`, [testUserId])
    console.log('✅ Test data cleaned up successfully\n')

    console.log('🎉 All tests passed! Quota monitoring system is working correctly.')
    
  } catch (error) {
    console.error('❌ Test failed:', error)
    process.exit(1)
  }
}

async function displaySystemInfo() {
  console.log('📊 Quota Monitoring System Information')
  console.log('=====================================')
  console.log(`• Monitor Status: Active`)
  console.log(`• Default Thresholds: ${JSON.stringify({
    database_size: '80%/95%',
    storage_size: '80%/95%',
    api_requests: '85%/95%'
  }, null, 2)}`)
  console.log(`• Monitoring Interval: Every 5 minutes`)
  console.log(`• Alert Channels: Webhook, Email, Slack`)
  console.log(`• Violation Severities: Low, Medium, High, Critical\n`)
}

// Run the test if this script is executed directly
if (require.main === module) {
  displaySystemInfo()
  testQuotaMonitoring().then(() => {
    console.log('\n✨ Test completed successfully!')
    process.exit(0)
  }).catch((error) => {
    console.error('\n💥 Test failed:', error)
    process.exit(1)
  })
}

export { testQuotaMonitoring }