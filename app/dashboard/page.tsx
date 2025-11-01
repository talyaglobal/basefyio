"use client"

import { useEffect } from "react"
import { useWorkspace } from "@/components/workspace-context"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Database,
  Table2,
  Code2,
  Activity,
  Key,
  HardDrive,
  TrendingUp,
  Clock,
  ArrowRight,
  Zap,
  Shield,
  FileText,
  Building2,
  FolderOpen,
  AlertCircle,
} from "lucide-react"
import Link from "next/link"

export default function DashboardPage() {
  const workspace = useWorkspace()

  useEffect(() => {
    workspace.refreshWorkspace()
  }, [])

  // Show empty state if no team selected
  if (!workspace.selectedTeam) {
    return (
      <div className="space-y-6">
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Team Selected</h3>
            <p className="text-sm text-muted-foreground mb-4 text-center max-w-md">
              Create or select a team to get started. Teams help you organize projects and collaborate with others.
            </p>
            <Button onClick={() => workspace.refreshWorkspace()}>
              Refresh Teams
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Show empty state if no project selected
  if (!workspace.selectedProject) {
    return (
      <div className="space-y-6">
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <FolderOpen className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Project Selected</h3>
            <p className="text-sm text-muted-foreground mb-4 text-center max-w-md">
              Select or create a project in <strong>{workspace.selectedTeam.name}</strong> to continue.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Show empty state if no database selected
  if (!workspace.selectedDatabase) {
    return (
      <div className="space-y-6">
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Database className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Database Selected</h3>
            <p className="text-sm text-muted-foreground mb-4 text-center max-w-md">
              Select or create a database in <strong>{workspace.selectedProject.name}</strong> to view your dashboard.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Mock stats - in production, fetch from API based on selected database
  const stats = {
    databases: workspace.databases.length,
    tables: 12,
    queries: 8,
    apiKeys: 3,
    storage: "2.4 GB",
    requests: "1.2K",
    uptime: "99.9%",
    recentActivity: [
      { id: 1, action: "Table created", table: "users", time: "2 minutes ago", type: "create" },
      { id: 2, action: "Query executed", table: "products", time: "15 minutes ago", type: "query" },
      { id: 3, action: "API key generated", table: "production", time: "1 hour ago", type: "api" },
      { id: 4, action: "Row updated", table: "orders", time: "2 hours ago", type: "update" },
      { id: 5, action: "Policy created", table: "users", time: "3 hours ago", type: "security" },
    ],
    quickActions: [
      {
        title: "Create Table",
        description: "Add a new table to your database",
        icon: Table2,
        href: "/dashboard/tables",
        color: "text-blue-500",
      },
      {
        title: "Run Query",
        description: "Execute SQL queries",
        icon: Code2,
        href: "/dashboard/sql",
        color: "text-green-500",
      },
      {
        title: "Generate API Key",
        description: "Create new API credentials",
        icon: Key,
        href: "/dashboard/api-keys",
        color: "text-purple-500",
      },
      {
        title: "Upload Files",
        description: "Manage storage buckets",
        icon: HardDrive,
        href: "/dashboard/storage",
        color: "text-orange-500",
      },
    ],
  }

  return (
    <div className="space-y-6">
      {/* Workspace context info */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Building2 className="h-4 w-4" />
        <span>{workspace.selectedTeam.name}</span>
        <span>/</span>
        <FolderOpen className="h-4 w-4" />
        <span>{workspace.selectedProject.name}</span>
        <span>/</span>
        <Database className="h-4 w-4" />
        <span className="font-medium">{workspace.selectedDatabase.name}</span>
        {workspace.selectedDatabase.status !== "active" && (
          <Badge variant="secondary" className="ml-2">
            {workspace.selectedDatabase.status}
          </Badge>
        )}
      </div>

      <div className="rounded-lg bg-gradient-to-r from-primary/10 via-primary/5 to-background border p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">
              {workspace.selectedDatabase.name}
            </h2>
            <p className="text-muted-foreground mt-1">
              Here's what's happening with your database today.
            </p>
          </div>
          <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20">
            <Activity className="h-3 w-3 mr-1" />
            {workspace.selectedDatabase.status === "active" ? "All Systems Operational" : "Database Status: " + workspace.selectedDatabase.status}
          </Badge>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Databases</CardTitle>
            <div className="h-8 w-8 rounded-full bg-blue-500/10 flex items-center justify-center">
              <Database className="h-4 w-4 text-blue-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.databases}</div>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
              <TrendingUp className="h-3 w-3 text-green-500" />
              In this project
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Tables</CardTitle>
            <div className="h-8 w-8 rounded-full bg-green-500/10 flex items-center justify-center">
              <Table2 className="h-4 w-4 text-green-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.tables}</div>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
              <TrendingUp className="h-3 w-3 text-green-500" />
              +2 this week
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Saved Queries</CardTitle>
            <div className="h-8 w-8 rounded-full bg-purple-500/10 flex items-center justify-center">
              <Code2 className="h-4 w-4 text-purple-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.queries}</div>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
              <FileText className="h-3 w-3" />
              Ready to execute
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">API Keys</CardTitle>
            <div className="h-8 w-8 rounded-full bg-orange-500/10 flex items-center justify-center">
              <Key className="h-4 w-4 text-orange-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.apiKeys}</div>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
              <Shield className="h-3 w-3 text-green-500" />
              All secure
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Recent Activity</CardTitle>
                <CardDescription>Latest changes in your database</CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/dashboard/activity">
                  View All
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {stats.recentActivity.map((activity) => (
                <div key={activity.id} className="flex items-start gap-3 pb-3 border-b last:border-0 last:pb-0">
                  <div
                    className={`h-8 w-8 rounded-full flex items-center justify-center ${
                      activity.type === "create"
                        ? "bg-green-500/10"
                        : activity.type === "query"
                          ? "bg-blue-500/10"
                          : activity.type === "api"
                            ? "bg-purple-500/10"
                            : activity.type === "update"
                              ? "bg-orange-500/10"
                              : "bg-red-500/10"
                    }`}
                  >
                    {activity.type === "create" && <Table2 className="h-4 w-4 text-green-500" />}
                    {activity.type === "query" && <Code2 className="h-4 w-4 text-blue-500" />}
                    {activity.type === "api" && <Key className="h-4 w-4 text-purple-500" />}
                    {activity.type === "update" && <Activity className="h-4 w-4 text-orange-500" />}
                    {activity.type === "security" && <Shield className="h-4 w-4 text-red-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{activity.action}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-mono">{activity.table}</span> • {activity.time}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
            <CardDescription>Common tasks to get you started</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3">
              {stats.quickActions.map((action) => (
                <Link key={action.title} href={action.href}>
                  <div className="flex items-center gap-3 rounded-lg border p-4 hover:bg-accent hover:border-primary/50 transition-all cursor-pointer group">
                    <div
                      className={`h-10 w-10 rounded-lg bg-accent flex items-center justify-center group-hover:scale-110 transition-transform ${action.color}`}
                    >
                      <action.icon className="h-5 w-5" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-medium text-sm">{action.title}</h3>
                      <p className="text-xs text-muted-foreground">{action.description}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all" />
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Storage Used</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.storage}</div>
            <div className="mt-2 h-2 bg-secondary rounded-full overflow-hidden">
              <div className="h-full bg-primary rounded-full" style={{ width: "24%" }} />
            </div>
            <p className="text-xs text-muted-foreground mt-2">24% of 10 GB used</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">API Requests</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.requests}</div>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
              <TrendingUp className="h-3 w-3 text-green-500" />
              +12% from last week
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Uptime</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.uptime}</div>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
              <Activity className="h-3 w-3 text-green-500" />
              Last 30 days
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
