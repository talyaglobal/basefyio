"use client"

import { useWorkspace } from "@/components/workspace-context"
import { Database } from "@/types"
import { useMemo } from "react"

/**
 * Hook to get the selected database with validation
 * Throws error if no database is selected (for use in components that require a database)
 */
export function useDatabaseContext() {
  const workspace = useWorkspace()
  
  const database = useMemo(() => {
    return workspace.selectedDatabase
  }, [workspace.selectedDatabase])

  const hasDatabase = !!database
  const databaseUrl = database?.database_url || null

  return {
    database,
    hasDatabase,
    databaseUrl,
    team: workspace.selectedTeam,
    project: workspace.selectedProject,
    isLoading: workspace.loading,
  }
}

/**
 * Hook to get database connection info for API calls
 * Returns null if no database selected
 */
export function useDatabaseConnection() {
  const workspace = useWorkspace()
  const { database, hasDatabase } = useDatabaseContext()
  
  if (!hasDatabase || !database) {
    return null
  }

  return {
    databaseId: database.id,
    databaseUrl: database.database_url,
    projectId: database.project_id,
    teamId: workspace.selectedTeam?.id,
  }
}

