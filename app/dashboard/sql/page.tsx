import { getUser } from "@/lib/auth"
import { SqlEditor } from "@/components/sql-editor"

export default async function SqlPage() {
  const user = await getUser()

  return (
    <div className="space-y-6">
      <SqlEditor />
    </div>
  )
}
