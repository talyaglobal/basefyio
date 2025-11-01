"use client"

import { useDatabaseContext } from "@/hooks/use-database-context"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Database, Building2, FolderOpen, AlertCircle } from "lucide-react"

interface DatabaseRequiredProps {
  children: React.ReactNode
  message?: string
}

/**
 * Component that ensures a database is selected before rendering children
 * Shows appropriate empty states if team/project/database is missing
 */
export function DatabaseRequired({ children, message }: DatabaseRequiredProps) {
  const { database, hasDatabase, team, project, isLoading } = useDatabaseContext()

  if (isLoading) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-4"></div>
          <p className="text-sm text-muted-foreground">Loading workspace...</p>
        </CardContent>
      </Card>
    )
  }

  if (!team) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">No Team Selected</h3>
          <p className="text-sm text-muted-foreground mb-4 text-center max-w-md">
            Create or select a team to get started.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (!project) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <FolderOpen className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">No Project Selected</h3>
          <p className="text-sm text-muted-foreground mb-4 text-center max-w-md">
            Select or create a project in <strong>{team.name}</strong> to continue.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (!hasDatabase || !database) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Database className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">No Database Selected</h3>
          <p className="text-sm text-muted-foreground mb-4 text-center max-w-md">
            {message || `Select or create a database in "${project.name}" to continue.`}
          </p>
        </CardContent>
      </Card>
    )
  }

  if (database.status !== "active") {
    return (
      <Card className="border-yellow-500/20 bg-yellow-500/5">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <AlertCircle className="h-12 w-12 text-yellow-500 mb-4" />
          <h3 className="text-lg font-semibold mb-2">Database Not Active</h3>
          <p className="text-sm text-muted-foreground mb-4 text-center max-w-md">
            The database "{database.name}" is currently <strong>{database.status}</strong>.
            Please select an active database to continue.
          </p>
        </CardContent>
      </Card>
    )
  }

  return <>{children}</>
}

