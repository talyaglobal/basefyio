"use client"

import { SqlEditor } from "@/components/sql-editor"
import { DatabaseRequired } from "@/components/database-required"

export default function SqlPage() {
  return (
    <DatabaseRequired message="Select or create a database to execute SQL queries.">
      <div className="space-y-6">
        <SqlEditor />
      </div>
    </DatabaseRequired>
  )
}
