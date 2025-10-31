import { TableBrowser } from "@/components/table-browser"
import DashboardHeader from "@/components/dashboard-header"

// Force dynamic rendering for tables with real-time data
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function TablesPage() {
  // const user = await getUser()

  return (
    <div className="space-y-6">
      <DashboardHeader />
      <TableBrowser />
    </div>
  )
}
