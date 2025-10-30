"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
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
} from "lucide-react"

const navItems = [
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
  {
    title: "RLS Policies",
    href: "/dashboard/rls",
    icon: Shield,
  },
  {
    title: "API Playground",
    href: "/dashboard/api-playground",
    icon: Zap,
  },
  {
    title: "Webhooks",
    href: "/dashboard/webhooks",
    icon: Webhook,
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
    title: "API Keys",
    href: "/dashboard/api-keys",
    icon: Key,
  },
  {
    title: "Settings",
    href: "/dashboard/settings",
    icon: Settings,
  },
]

interface DashboardNavProps {
  mobile?: boolean
}

export function DashboardNav({ mobile = false }: DashboardNavProps) {
  const pathname = usePathname()
  const router = useRouter()

  const handleSignOut = async () => {
    await fetch("/api/auth/sign-out", { method: "POST" })
    router.push("/sign-in")
    router.refresh()
  }

  return (
    <div className={cn("flex h-full flex-col", mobile ? "p-4" : "p-4")}>
      {/* Logo */}
      <div className="mb-6">
        <h2 className="text-lg font-semibold">Kolaybase</h2>
        <p className="text-xs text-muted-foreground">Database Management</p>
      </div>

      {/* Navigation items */}
      <nav className="flex-1 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.title}
            </Link>
          )
        })}
      </nav>

      {/* Sign out button */}
      <div className="mt-auto pt-4 border-t">
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 text-muted-foreground hover:text-foreground"
          onClick={handleSignOut}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </div>
  )
}
