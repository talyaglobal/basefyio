import { QuotaMonitorDashboard } from "@/components/quota-monitor-dashboard"

export default function QuotaMonitorPage() {
  return (
    <div className="container mx-auto py-6">
      <QuotaMonitorDashboard />
    </div>
  )
}

export const metadata = {
  title: "Quota Monitor",
  description: "Monitor resource quotas and usage violations",
}