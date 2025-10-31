import { getUser } from "@/lib/auth"
import { SqlEditor } from "@/components/sql-editor"

// Force dynamic rendering for SQL editor with real-time query results
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function SqlPage() {
  const user = await getUser()

  return (
    <div className="space-y-6">
      <SqlEditor />
    </div>
  )
}
