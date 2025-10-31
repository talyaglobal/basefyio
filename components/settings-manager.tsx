"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { User, Database, Bell, Shield, Trash2 } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"

interface SettingsManagerProps {
  user: {
    id: string
    email: string
  } | null
}

export function SettingsManager({ user }: SettingsManagerProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  // Account settings
  const [email, setEmail] = useState(user?.email || "")
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")

  // Database settings
  const [databaseUrl, setDatabaseUrl] = useState(process.env.NEXT_PUBLIC_DATABASE_URL || "")

  // Notification settings
  const [emailNotifications, setEmailNotifications] = useState(true)
  const [queryAlerts, setQueryAlerts] = useState(false)
  const [storageAlerts, setStorageAlerts] = useState(true)

  // MFA state
  const [mfaEnabled, setMfaEnabled] = useState(false)
  const [mfaSecret, setMfaSecret] = useState("")
  const [mfaOtpauth, setMfaOtpauth] = useState("")
  const [mfaCode, setMfaCode] = useState("")

  const startMfaSetup = async () => {
    if (!user?.email || !user?.id) {
      setError("Sign in to configure MFA")
      return
    }
    setLoading(true)
    setError("")
    setSuccess("")
    try {
      const res = await fetch("/api/auth/mfa/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || "Failed to start MFA setup")
      setMfaSecret(data.secret)
      setMfaOtpauth(data.otpauth)
    } catch (e: any) {
      setError(e?.message || "Failed to start MFA setup")
    } finally {
      setLoading(false)
    }
  }

  const verifyMfa = async () => {
    if (!user?.id) return
    setLoading(true)
    setError("")
    setSuccess("")
    try {
      const res = await fetch("/api/auth/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: mfaCode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || "Invalid MFA code")
      setMfaEnabled(true)
      setSuccess("MFA enabled successfully")
      setMfaCode("")
      setMfaSecret("")
      setMfaOtpauth("")
    } catch (e: any) {
      setError(e?.message || "Failed to verify MFA")
    } finally {
      setLoading(false)
    }
  }

  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [recoveryCodesLoading, setRecoveryCodesLoading] = useState(false)

  const generateRecoveryCodes = async () => {
    setRecoveryCodesLoading(true)
    setError("")
    try {
      const res = await fetch("/api/auth/mfa/recovery", { method: "POST" })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || "Failed to generate recovery codes")
      setRecoveryCodes(data.codes || [])
      setSuccess("Recovery codes generated. Save them securely.")
    } catch (e: any) {
      setError(e?.message || "Failed to generate recovery codes")
    } finally {
      setRecoveryCodesLoading(false)
    }
  }

  const updateEmail = async () => {
    setLoading(true)
    setError("")
    setSuccess("")

    try {
      const response = await fetch("/api/settings/email", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error)

      setSuccess("Email updated successfully")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update email")
    } finally {
      setLoading(false)
    }
  }

  const updatePassword = async () => {
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match")
      return
    }

    if (newPassword.length < 6) {
      setError("Password must be at least 6 characters")
      return
    }

    setLoading(true)
    setError("")
    setSuccess("")

    try {
      const response = await fetch("/api/settings/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error)

      setSuccess("Password updated successfully")
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update password")
    } finally {
      setLoading(false)
    }
  }

  const deleteAccount = async () => {
    if (!confirm("Are you sure you want to delete your account? This action cannot be undone.")) return

    const confirmText = prompt('Type "DELETE" to confirm account deletion:')
    if (confirmText !== "DELETE") return

    setLoading(true)
    setError("")

    try {
      const response = await fetch("/api/settings/account", {
        method: "DELETE",
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error)

      window.location.href = "/sign-in"
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete account")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert>
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="account">
        <TabsList>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="database">Database</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        <TabsContent value="account" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="h-5 w-5" />
                Account Information
              </CardTitle>
              <CardDescription>Update your account details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email Address</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <Button onClick={updateEmail} disabled={loading || email === user?.email}>
                {loading ? "Updating..." : "Update Email"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Change Password</CardTitle>
              <CardDescription>Update your password to keep your account secure</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="current-password">Current Password</Label>
                <Input
                  id="current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-password">New Password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm New Password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
              <Button
                onClick={updatePassword}
                disabled={loading || !currentPassword || !newPassword || !confirmPassword}
              >
                {loading ? "Updating..." : "Update Password"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="database" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                Database Connection
              </CardTitle>
              <CardDescription>Manage your database connection settings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="database-url">Database URL</Label>
                <Input
                  id="database-url"
                  type="text"
                  value={databaseUrl}
                  onChange={(e) => setDatabaseUrl(e.target.value)}
                  placeholder="postgresql://..."
                  disabled
                />
                <p className="text-sm text-muted-foreground">
                  Your database connection is managed through environment variables
                </p>
              </div>

              <Separator />

              <div className="space-y-3">
                <h4 className="text-sm font-medium">Connection Status</h4>
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">Neon Database</p>
                    <p className="text-xs text-muted-foreground">Connected and active</p>
                  </div>
                  <div className="h-2 w-2 rounded-full bg-green-500" />
                </div>
              </div>

              <Separator />

              <div className="space-y-3">
                <h4 className="text-sm font-medium">Database Statistics</h4>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="p-3 border rounded-lg">
                    <p className="text-xs text-muted-foreground">Total Tables</p>
                    <p className="text-2xl font-bold">8</p>
                  </div>
                  <div className="p-3 border rounded-lg">
                    <p className="text-xs text-muted-foreground">Total Records</p>
                    <p className="text-2xl font-bold">1,234</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bell className="h-5 w-5" />
                Notification Preferences
              </CardTitle>
              <CardDescription>Choose what notifications you want to receive</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Email Notifications</Label>
                  <p className="text-sm text-muted-foreground">Receive email updates about your account</p>
                </div>
                <Switch checked={emailNotifications} onCheckedChange={setEmailNotifications} />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Query Alerts</Label>
                  <p className="text-sm text-muted-foreground">Get notified about long-running queries</p>
                </div>
                <Switch checked={queryAlerts} onCheckedChange={setQueryAlerts} />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Storage Alerts</Label>
                  <p className="text-sm text-muted-foreground">Alerts when storage usage is high</p>
                </div>
                <Switch checked={storageAlerts} onCheckedChange={setStorageAlerts} />
              </div>

              <Button className="mt-4">Save Preferences</Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Security Settings
              </CardTitle>
              <CardDescription>Manage your account security</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <h4 className="text-sm font-medium">Active Sessions</h4>
                <div className="p-3 border rounded-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">Current Session</p>
                      <p className="text-xs text-muted-foreground">Last active: Just now</p>
                    </div>
                    <div className="h-2 w-2 rounded-full bg-green-500" />
                  </div>
                </div>
              </div>

              <Separator />

              <div className="space-y-3">
                <h4 className="text-sm font-medium">Two-Factor Authentication</h4>
                <p className="text-sm text-muted-foreground">Add an extra layer of security to your account</p>
                {!mfaSecret && !mfaEnabled && (
                  <Button variant="outline" onClick={startMfaSetup} disabled={loading || !user}>
                    {loading ? "Preparing..." : "Enable 2FA"}
                  </Button>
                )}
                {mfaSecret && !mfaEnabled && (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label>Secret</Label>
                      <Input value={mfaSecret} readOnly onFocus={(e) => e.currentTarget.select()} />
                      <p className="text-xs text-muted-foreground">Add this secret to your authenticator app (or use the otpauth link below).</p>
                    </div>
                    <div className="space-y-1">
                      <Label>otpauth URL</Label>
                      <Input value={mfaOtpauth} readOnly onFocus={(e) => e.currentTarget.select()} />
                    </div>
                    <div className="space-y-2">
                      <Label>Enter code from your app</Label>
                      <div className="flex gap-2">
                        <Input
                          placeholder="123 456"
                          value={mfaCode}
                          onChange={(e) => setMfaCode(e.target.value)}
                          inputMode="numeric"
                          pattern="[0-9]*"
                        />
                        <Button onClick={verifyMfa} disabled={loading || !mfaCode}>
                          {loading ? "Verifying..." : "Verify"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
                {mfaEnabled && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-green-600 text-sm">
                      2FA enabled for this account
                    </div>
                    <Separator />
                    <div className="space-y-2">
                      <h4 className="text-sm font-medium">Recovery Codes</h4>
                      <p className="text-xs text-muted-foreground">
                        Save these codes in a safe place. You can use them to access your account if you lose access to your authenticator app.
                      </p>
                      {recoveryCodes.length > 0 ? (
                        <div className="p-3 border rounded-lg bg-muted space-y-2">
                          {recoveryCodes.map((code, i) => (
                            <code key={i} className="block font-mono text-xs">
                              {code}
                            </code>
                          ))}
                        </div>
                      ) : (
                        <Button variant="outline" onClick={generateRecoveryCodes} disabled={recoveryCodesLoading}>
                          {recoveryCodesLoading ? "Generating..." : "Generate Recovery Codes"}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-destructive">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <Trash2 className="h-5 w-5" />
                Danger Zone
              </CardTitle>
              <CardDescription>Irreversible actions for your account</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Delete Account</h4>
                <p className="text-sm text-muted-foreground">
                  Permanently delete your account and all associated data. This action cannot be undone.
                </p>
                <Button variant="destructive" onClick={deleteAccount} disabled={loading}>
                  {loading ? "Deleting..." : "Delete Account"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
