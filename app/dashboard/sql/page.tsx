import { getUser } from "@/lib/auth"
import { SqlEditor } from "@/components/sql-editor"
import DashboardHeader from "@/components/dashboard-header" // Assuming DashboardHeader is the shared component

export default async function SqlPage() {
  const user = await getUser()

  return (
    <div className="space-y-6">
      <DashboardHeader title="SQL Editor" description="Write and execute SQL queries with syntax highlighting" />
      <SqlEditor />
    </div>
  )
}
