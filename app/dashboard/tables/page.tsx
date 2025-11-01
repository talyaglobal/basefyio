"use client"

import { TableBrowser } from "@/components/table-browser"
import { DatabaseRequired } from "@/components/database-required"

export default function TablesPage() {
  return (
    <DatabaseRequired message="Select or create a database to browse tables.">
      <div className="space-y-6">
        <TableBrowser />
      </div>
    </DatabaseRequired>
  )
}
