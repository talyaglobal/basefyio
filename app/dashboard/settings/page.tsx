import { getUser } from "@/lib/auth"
import { SettingsManager } from "@/components/settings-manager"

export default async function SettingsPage() {
  const user = await getUser()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-1">Manage your account and database settings</p>
      </div>
      <SettingsManager user={user} />
    </div>
  )
}
