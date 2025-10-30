import { getUser } from "@/lib/auth"
import { StorageBrowser } from "@/components/storage-browser"

export default async function StoragePage() {
  const user = await getUser()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Storage Browser</h1>
        <p className="text-muted-foreground mt-1">Manage your file storage and uploads</p>
      </div>
      <StorageBrowser />
    </div>
  )
}
