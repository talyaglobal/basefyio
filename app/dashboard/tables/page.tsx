import { TableBrowser } from "@/components/table-browser"
import DashboardHeader from "@/components/dashboard-header"

export default async function TablesPage() {
  // const user = await getUser()

  return (
    <div className="space-y-6">
      <DashboardHeader title="Table Editor" subtitle="Browse and edit your database tables" />
      <TableBrowser />
    </div>
  )
}
