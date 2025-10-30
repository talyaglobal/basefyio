"use client"

import { usePathname } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Menu, Bell, User } from "lucide-react"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { DashboardNav } from "./dashboard-nav"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { useRouter } from "next/navigation"

interface DashboardHeaderProps {
  userEmail?: string
}

const routeTitles: Record<string, { title: string; description: string }> = {
  "/dashboard": { title: "Overview", description: "Welcome to your Kolaybase dashboard" },
  "/dashboard/tables": { title: "Table Editor", description: "Browse and edit your database tables" },
  "/dashboard/sql": { title: "SQL Editor", description: "Write and execute SQL queries with syntax highlighting" },
  "/dashboard/rls": { title: "RLS Policies", description: "Manage Row Level Security policies" },
  "/dashboard/api-playground": { title: "API Playground", description: "Test your API endpoints with code generation" },
  "/dashboard/webhooks": { title: "Webhooks", description: "Manage webhook endpoints and events" },
  "/dashboard/import": { title: "Data Import", description: "Import data from CSV or JSON files" },
  "/dashboard/migrations": { title: "Migrations", description: "Manage database schema migrations" },
  "/dashboard/graphql": { title: "GraphQL Explorer", description: "Test GraphQL queries and explore your API schema" },
  "/dashboard/storage": { title: "Storage Browser", description: "Manage files and media assets" },
  "/dashboard/api-keys": { title: "API Keys", description: "Manage API keys and access tokens" },
  "/dashboard/settings": { title: "Settings", description: "Configure your account and preferences" },
}

export function DashboardHeader({ userEmail }: DashboardHeaderProps) {
  const pathname = usePathname()
  const router = useRouter()
  const pageInfo = routeTitles[pathname] || { title: "Dashboard", description: "" }

  const handleSignOut = async () => {
    await fetch("/api/auth/sign-out", { method: "POST" })
    router.push("/sign-in")
    router.refresh()
  }

  const userInitials =
    userEmail
      ?.split("@")[0]
      .split(".")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2) || "U"

  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-16 items-center gap-4 px-6">
        {/* Mobile menu trigger */}
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="md:hidden">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0">
            <DashboardNav mobile />
          </SheetContent>
        </Sheet>

        {/* Page title */}
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{pageInfo.title}</h1>
          {pageInfo.description && (
            <p className="text-sm text-muted-foreground hidden sm:block">{pageInfo.description}</p>
          )}
        </div>

        {/* Right side actions */}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="relative">
            <Bell className="h-5 w-5" />
            <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="gap-2">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="bg-primary text-primary-foreground text-xs">{userInitials}</AvatarFallback>
                </Avatar>
                <span className="hidden sm:inline text-sm">{userEmail}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>My Account</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push("/dashboard/settings")}>
                <User className="mr-2 h-4 w-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleSignOut} className="text-destructive">
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  )
}

export default DashboardHeader
