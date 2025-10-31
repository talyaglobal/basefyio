import { TableBrowser } from "@/components/table-browser"
import DashboardHeader from "@/components/dashboard-header"

export default async function TablesPage() {
  // const user = await getUser()

  return (
    <div className="space-y-6">
      <DashboardHeader />
      <TableBrowser />
    </div>
  )
}
