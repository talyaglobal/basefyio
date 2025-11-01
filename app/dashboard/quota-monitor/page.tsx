"use client"

import { QuotaMonitorDashboard } from "@/components/quota-monitor-dashboard"
import { DatabaseRequired } from "@/components/database-required"

export default function QuotaMonitorPage() {
  return (
    <DatabaseRequired message="Select or create a database to monitor quotas.">
      <div className="container mx-auto py-6">
        <QuotaMonitorDashboard />
      </div>
    </DatabaseRequired>
  )
}