"use client"

import { StorageBrowser } from "@/components/storage-browser"
import { DatabaseRequired } from "@/components/database-required"

export default function StoragePage() {
  return (
    <DatabaseRequired message="Select or create a database to manage storage.">
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Storage Browser</h1>
          <p className="text-muted-foreground mt-1">Manage your file storage and uploads</p>
        </div>
        <StorageBrowser />
      </div>
    </DatabaseRequired>
  )
}
