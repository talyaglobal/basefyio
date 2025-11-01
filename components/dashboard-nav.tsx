"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import {
  Database,
  Table2,
  Code2,
  Activity,
  FolderOpen,
  Key,
  Settings,
  LogOut,
  Shield,
  Webhook,
  FileUp,
  History,
  Zap,
  ChevronRight,
  Building2,
  Plug2,
} from "lucide-react"
import { useWorkspace } from "@/components/workspace-context"

const navGroups = [
  {
    title: "Database",
    items: [
      {
        title: "Overview",
        href: "/dashboard",
        icon: Database,
      },
      {
        title: "Table Editor",
        href: "/dashboard/tables",
        icon: Table2,
      },
      {
        title: "SQL Editor",
        href: "/dashboard/sql",
        icon: Code2,
      },
    ],
  },
  {
    title: "Security & APIs",
    items: [
      {
        title: "RLS Policies",
        href: "/dashboard/rls",
        icon: Shield,
      },
      {
        title: "API Playground",
        href: "/dashboard/api-playground",
        icon: Zap,
        badge: "New",
      },
      {
        title: "API Keys",
        href: "/dashboard/api-keys",
        icon: Key,
      },
      {
        title: "Webhooks",
        href: "/dashboard/webhooks",
        icon: Webhook,
      },
    ],
  },
  {
    title: "Tools",
    items: [
      {
        title: "Quota Monitor",
        href: "/dashboard/quota-monitor",
        icon: Shield,
        badge: "New",
      },
      {
        title: "GraphQL",
        href: "/dashboard/graphql",
        icon: Activity,
      },
      {
        title: "Storage",
        href: "/dashboard/storage",
        icon: FolderOpen,
      },
      {
        title: "Data Import",
        href: "/dashboard/import",
        icon: FileUp,
      },
      {
        title: "Migrations",
        href: "/dashboard/migrations",
        icon: History,
      },
    ],
  },
  {
    title: "Integrations",
    items: [
      {
        title: "Integrations",
        href: "/dashboard/integrations",
        icon: Plug2,
      },
    ],
  },
]

interface DashboardNavProps {
  mobile?: boolean
  userEmail?: string
}

export function DashboardNav({ mobile = false, userEmail }: DashboardNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { selectedTeam, selectedProject, selectedDatabase } = useWorkspace()

  const handleSignOut = async () => {
    await fetch("/api/auth/sign-out", { method: "POST" })
    router.push("/sign-in")
    router.refresh()
  }

  const userInitials = userEmail
    ? userEmail
        .split("@")[0]
        .split(".")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "U"

  return (
    <div className={cn("flex h-full flex-col bg-sidebar", mobile ? "p-4" : "")}>
      <div className="px-6 py-5 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <Database className="h-4 w-4 text-primary-foreground" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-sidebar-foreground">Kolaybase</h2>
            <p className="text-xs text-muted-foreground">Database Console</p>
          </div>
        </div>
      </div>

      {/* Workspace Breadcrumb */}
      {(selectedTeam || selectedProject || selectedDatabase) && (
        <div className="px-6 py-3 border-b border-sidebar-border bg-sidebar-accent/30">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground overflow-hidden">
            {selectedTeam && (
              <>
                <div className="flex items-center gap-1.5 min-w-0 flex-shrink">
                  <Building2 className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate font-medium text-sidebar-foreground/90">{selectedTeam.name}</span>
                </div>
                {selectedProject && <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
              </>
            )}
            {selectedProject && (
              <>
                <div className="flex items-center gap-1.5 min-w-0 flex-shrink">
                  <FolderOpen className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate font-medium text-sidebar-foreground/90">{selectedProject.name}</span>
                </div>
                {selectedDatabase && <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
              </>
            )}
            {selectedDatabase && (
              <div className="flex items-center gap-1.5 min-w-0 flex-shrink">
                <Database className="h-3 w-3 flex-shrink-0" />
                <span className="truncate font-medium text-sidebar-foreground/90">{selectedDatabase.name}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <div className="space-y-6">
          {navGroups.map((group) => (
            <div key={group.title}>
              <h3 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.title}
              </h3>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon
                  const isActive = pathname === item.href
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                        isActive
                          ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      )}
                    >
                      <Icon className={cn("h-4 w-4 shrink-0", isActive ? "text-sidebar-primary-foreground" : "")} />
                      <span className="flex-1">{item.title}</span>
                      {item.badge && (
                        <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                          {item.badge}
                        </Badge>
                      )}
                      {isActive && <ChevronRight className="h-4 w-4 shrink-0" />}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}

          <div>
            <Link
              href="/dashboard/settings"
              className={cn(
                "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                pathname === "/dashboard/settings"
                  ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <Settings className="h-4 w-4 shrink-0" />
              <span className="flex-1">Settings</span>
              {pathname === "/dashboard/settings" && <ChevronRight className="h-4 w-4 shrink-0" />}
            </Link>
          </div>
        </div>
      </nav>

      <div className="mt-auto border-t border-sidebar-border p-4">
        <div className="flex items-center gap-3 rounded-lg bg-sidebar-accent/50 p-3">
          <Avatar className="h-9 w-9 border-2 border-sidebar-border">
            <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">
              {userInitials}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-sidebar-foreground truncate">{userEmail || "User"}</p>
            <p className="text-xs text-muted-foreground">Admin</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={handleSignOut}
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
