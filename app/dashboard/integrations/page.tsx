"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import {
  Github,
  GitBranch,
  Cloud,
  Rocket,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ExternalLink,
  Settings,
  Clock,
  AlertCircle,
  Loader2,
  Plug2,
} from "lucide-react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"

interface Integration {
  id: string
  provider: "github" | "gitlab" | "kolaylabs" | "vercel" | "kolaydeploy"
  status: "pending" | "connected" | "disconnected" | "error"
  provider_username?: string
  provider_email?: string
  provider_avatar_url?: string
  last_sync_at?: string
  sync_status?: "idle" | "syncing" | "success" | "failed"
  sync_error?: string
  connected_at?: string
  config?: {
    auto_sync?: boolean
    repos?: string[]
    permissions?: string[]
    webhook_url?: string
    environments?: string[]
  }
}

const INTEGRATIONS = [
  {
    id: "github",
    name: "GitHub",
    description: "Connect your GitHub repositories for automated deployments and imports",
    icon: Github,
    color: "bg-gray-900 text-white",
    features: ["Repo access", "Auto-sync on push", "Import projects", "CI/CD integration"],
    oauthSupported: true,
  },
  {
    id: "gitlab",
    name: "GitLab",
    description: "Integrate GitLab repositories with token or OAuth authentication",
    icon: GitBranch,
    color: "bg-orange-600 text-white",
    features: ["Group & project selection", "Pipeline triggers", "CI/CD metadata"],
    oauthSupported: true,
  },
  {
    id: "kolaylabs",
    name: "KolayLabs",
    description: "Sync with KolayLabs workspace for build logs and secrets management",
    icon: Rocket,
    color: "bg-purple-600 text-white",
    features: ["Workspace sync", "Build logs", "Environment variables", "Secrets management"],
    oauthSupported: false,
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Connect Vercel projects for domain management and deployment control",
    icon: Cloud,
    color: "bg-black text-white",
    features: ["Project domains", "Deploy status", "Rollback & redeploy"],
    oauthSupported: true,
  },
  {
    id: "kolaydeploy",
    name: "KolayDeploy",
    description: "Native deployment infrastructure integrated with Kolaybase backend",
    icon: Rocket,
    color: "bg-blue-600 text-white",
    features: ["Environment management", "Auto/manual deploy", "Log tracking", "Error alerts"],
    oauthSupported: false,
  },
]

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState<Record<string, boolean>>({})
  const { toast } = useToast()
  const searchParams = useSearchParams()

  useEffect(() => {
    fetchIntegrations()

    // Check for URL parameters (success/error from OAuth callback)
    const connected = searchParams.get("connected")
    const error = searchParams.get("error")

    if (connected === "true") {
      toast({
        title: "Connected",
        description: "Integration connected successfully",
      })
      // Clean URL
      window.history.replaceState({}, "", "/dashboard/integrations")
    } else if (error) {
      toast({
        title: "Connection failed",
        description: error.replace(/_/g, " "),
        variant: "destructive",
      })
      // Clean URL
      window.history.replaceState({}, "", "/dashboard/integrations")
    }
  }, [searchParams, toast])

  const fetchIntegrations = async () => {
    try {
      const res = await fetch("/api/integrations")
      if (!res.ok) throw new Error("Failed to fetch integrations")
      const data = await res.json()
      setIntegrations(data.integrations || [])
    } catch (error) {
      console.error("Error fetching integrations:", error)
      toast({
        title: "Error",
        description: "Failed to load integrations",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  const handleConnect = async (provider: string) => {
    try {
      window.location.href = `/api/integrations/${provider}/connect`
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to connect to ${provider}`,
        variant: "destructive",
      })
    }
  }

  const handleDisconnect = async (integrationId: string, provider: string) => {
    if (!confirm(`Are you sure you want to disconnect ${provider}?`)) return

    try {
      const res = await fetch(`/api/integrations/${integrationId}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error("Failed to disconnect")
      
      toast({
        title: "Disconnected",
        description: `${provider} has been disconnected`,
      })
      fetchIntegrations()
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to disconnect ${provider}`,
        variant: "destructive",
      })
    }
  }

  const handleSync = async (integrationId: string, provider: string) => {
    setSyncing((prev) => ({ ...prev, [integrationId]: true }))
    try {
      const res = await fetch(`/api/integrations/${integrationId}/sync`, {
        method: "POST",
      })
      if (!res.ok) throw new Error("Sync failed")
      
      const data = await res.json()
      toast({
        title: "Sync started",
        description: `Syncing ${provider}...`,
      })
      fetchIntegrations()
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to sync ${provider}`,
        variant: "destructive",
      })
    } finally {
      setTimeout(() => {
        setSyncing((prev) => ({ ...prev, [integrationId]: false }))
      }, 2000)
    }
  }

  const getIntegrationStatus = (integration: Integration) => {
    if (integration.status === "connected") {
      if (integration.sync_status === "syncing") {
        return { label: "Syncing...", variant: "secondary" as const, icon: Loader2 }
      }
      if (integration.sync_status === "failed") {
        return { label: "Sync failed", variant: "destructive" as const, icon: AlertCircle }
      }
      if (integration.last_sync_at) {
        return { label: "Connected", variant: "default" as const, icon: CheckCircle2 }
      }
      return { label: "Connected", variant: "default" as const, icon: CheckCircle2 }
    }
    if (integration.status === "error") {
      return { label: "Error", variant: "destructive" as const, icon: XCircle }
    }
    if (integration.status === "pending") {
      return { label: "Pending", variant: "secondary" as const, icon: Clock }
    }
    return { label: "Disconnected", variant: "outline" as const, icon: XCircle }
  }

  const formatTimeAgo = (dateString?: string) => {
    if (!dateString) return "Never"
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return "Just now"
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    return `${diffDays}d ago`
  }

  const connectedIntegrations = integrations.filter((i) => i.status === "connected")
  const integrationMap = new Map(integrations.map((i) => [i.provider, i]))

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Integrations</h1>
        <p className="text-muted-foreground mt-2">
          Connect your code repositories and deployment platforms to streamline your workflow
        </p>
      </div>

      {/* Connected Integrations Summary */}
      {connectedIntegrations.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Connected Integrations</CardTitle>
                <CardDescription>
                  {connectedIntegrations.length} integration{connectedIntegrations.length !== 1 ? "s" : ""} active
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  fetchIntegrations()
                  toast({
                    title: "Refreshed",
                    description: "Integration status updated",
                  })
                }}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh All
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {connectedIntegrations.map((integration) => {
                const integrationConfig = INTEGRATIONS.find((i) => i.id === integration.provider)
                const Icon = integrationConfig?.icon || Plug2
                return (
                  <Badge key={integration.id} variant="secondary" className="px-3 py-1.5 gap-2">
                    <Icon className="h-3.5 w-3.5" />
                    <span>{integrationConfig?.name || integration.provider}</span>
                    {integration.provider_username && (
                      <span className="text-muted-foreground">@{integration.provider_username}</span>
                    )}
                  </Badge>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Integration Cards */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {INTEGRATIONS.map((integrationConfig) => {
          const integration = integrationMap.get(integrationConfig.id as Integration["provider"])
          const Icon = integrationConfig.icon
          const status = integration ? getIntegrationStatus(integration) : null
          const StatusIcon = status?.icon || XCircle

          return (
            <Card key={integrationConfig.id} className="hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className={`${integrationConfig.color} p-3 rounded-lg`}>
                    <Icon className="h-6 w-6" />
                  </div>
                  {status && (
                    <Badge variant={status.variant} className="gap-1">
                      <StatusIcon className={`h-3 w-3 ${integration?.sync_status === "syncing" ? "animate-spin" : ""}`} />
                      {status.label}
                    </Badge>
                  )}
                </div>
                <CardTitle className="mt-4">{integrationConfig.name}</CardTitle>
                <CardDescription>{integrationConfig.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Features */}
                <div className="space-y-1">
                  {integrationConfig.features.slice(0, 3).map((feature, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
                      <span>{feature}</span>
                    </div>
                  ))}
                </div>

                {/* Connection Info */}
                {integration && integration.status === "connected" && (
                  <div className="space-y-2 pt-2 border-t">
                    {integration.provider_username && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-muted-foreground">Account:</span>
                        <span className="font-medium">{integration.provider_username}</span>
                      </div>
                    )}
                    {integration.last_sync_at && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" />
                        <span>Last sync: {formatTimeAgo(integration.last_sync_at)}</span>
                      </div>
                    )}
                    {integration.sync_error && (
                      <div className="flex items-center gap-2 text-sm text-destructive">
                        <AlertCircle className="h-3.5 w-3.5" />
                        <span className="truncate">{integration.sync_error}</span>
                      </div>
                    )}
                    {integration.config?.auto_sync && (
                      <Badge variant="outline" className="text-xs">
                        Auto-sync enabled
                      </Badge>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-2">
                  {integration && integration.status === "connected" ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => handleSync(integration.id, integrationConfig.name)}
                        disabled={syncing[integration.id]}
                      >
                        {syncing[integration.id] ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4 mr-2" />
                        )}
                        Sync
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDisconnect(integration.id, integrationConfig.name)}
                      >
                        <Settings className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDisconnect(integration.id, integrationConfig.name)}
                      >
                        Disconnect
                      </Button>
                    </>
                  ) : (
                    <Button
                      className="flex-1"
                      onClick={() => handleConnect(integrationConfig.id)}
                      disabled={!integrationConfig.oauthSupported && integrationConfig.id !== "kolaydeploy"}
                    >
                      {integration?.status === "pending" ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Connecting...
                        </>
                      ) : (
                        <>
                          Connect
                          <ExternalLink className="h-4 w-4 ml-2" />
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Help Text */}
      <Card className="border-dashed">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium">About Integrations</p>
              <p className="text-sm text-muted-foreground">
                Integrations allow you to connect external services like GitHub, GitLab, and Vercel to your Kolaybase
                projects. Once connected, you can sync repositories, trigger deployments, and manage environments from
                one central location.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

