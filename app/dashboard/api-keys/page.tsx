"use client"

import { ApiKeyManager } from "@/components/api-key-manager"
import { DatabaseRequired } from "@/components/database-required"

export default function ApiKeysPage() {
  return (
    <DatabaseRequired message="Select or create a database to manage API keys.">
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">API Keys</h1>
          <p className="text-muted-foreground mt-1">Manage your API keys for programmatic access</p>
        </div>
        <ApiKeyManager />
      </div>
    </DatabaseRequired>
  )
}
