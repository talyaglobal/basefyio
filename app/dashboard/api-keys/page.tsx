import { getUser } from "@/lib/auth"
import { ApiKeyManager } from "@/components/api-key-manager"

// Force dynamic rendering for API keys management
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function ApiKeysPage() {
  const user = await getUser()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">API Keys</h1>
        <p className="text-muted-foreground mt-1">Manage your API keys for programmatic access</p>
      </div>
      <ApiKeyManager />
    </div>
  )
}
