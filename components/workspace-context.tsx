"use client"

import { createContext, useContext, useState, useEffect, ReactNode } from "react"
import { Team, Project, Database } from "@/types"

interface WorkspaceContextType {
  selectedTeam: Team | null
  selectedProject: Project | null
  selectedDatabase: Database | null
  teams: Team[]
  projects: Project[]
  databases: Database[]
  setSelectedTeam: (team: Team | null) => void
  setSelectedProject: (project: Project | null) => void
  setSelectedDatabase: (database: Database | null) => void
  refreshWorkspace: () => Promise<void>
  loading: boolean
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null)
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [selectedDatabase, setSelectedDatabase] = useState<Database | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [databases, setDatabases] = useState<Database[]>([])
  const [loading, setLoading] = useState(true)

  const refreshWorkspace = async () => {
    setLoading(true)
    try {
      // Fetch teams
      const teamsRes = await fetch("/api/teams")
      if (teamsRes.ok) {
        const teamsData = await teamsRes.json()
        setTeams(teamsData.teams || [])
        
        // Auto-select first team if none selected
        if (!selectedTeam && teamsData.teams?.length > 0) {
          setSelectedTeam(teamsData.teams[0])
        }
      }

      // Fetch projects for selected team
      if (selectedTeam) {
        const projectsRes = await fetch(`/api/projects?team_id=${selectedTeam.id}`)
        if (projectsRes.ok) {
          const projectsData = await projectsRes.json()
          setProjects(projectsData.projects || [])
          
          // Auto-select first project if none selected
          if (!selectedProject && projectsData.projects?.length > 0) {
            setSelectedProject(projectsData.projects[0])
          }
        }
      } else {
        setProjects([])
      }

      // Fetch databases for selected project
      if (selectedProject) {
        const databasesRes = await fetch(`/api/databases?project_id=${selectedProject.id}`)
        if (databasesRes.ok) {
          const databasesData = await databasesRes.json()
          setDatabases(databasesData.databases || [])
          
          // Auto-select first database if none selected
          if (!selectedDatabase && databasesData.databases?.length > 0) {
            setSelectedDatabase(databasesData.databases[0])
          }
        }
      } else {
        setDatabases([])
      }
    } catch (error) {
      console.error("Error refreshing workspace:", error)
    } finally {
      setLoading(false)
    }
  }

  // Load workspace data on mount
  useEffect(() => {
    const loadWorkspace = async () => {
      await refreshWorkspace()
      
      // Load from localStorage after data is fetched
      const storedTeamId = localStorage.getItem("selectedTeamId")
      const storedProjectId = localStorage.getItem("selectedProjectId")
      const storedDatabaseId = localStorage.getItem("selectedDatabaseId")

      if (storedTeamId) {
        const team = teams.find((t) => t.id === storedTeamId)
        if (team) setSelectedTeam(team)
      }
      if (storedProjectId) {
        const project = projects.find((p) => p.id === storedProjectId)
        if (project) setSelectedProject(project)
      }
      if (storedDatabaseId) {
        const database = databases.find((d) => d.id === storedDatabaseId)
        if (database) setSelectedDatabase(database)
      }
    }
    
    loadWorkspace()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Save to localStorage when selection changes
  useEffect(() => {
    if (selectedTeam) {
      localStorage.setItem("selectedTeamId", selectedTeam.id)
    } else {
      localStorage.removeItem("selectedTeamId")
    }
  }, [selectedTeam])

  useEffect(() => {
    if (selectedProject) {
      localStorage.setItem("selectedProjectId", selectedProject.id)
      // Refresh databases when project changes
      refreshWorkspace()
    } else {
      localStorage.removeItem("selectedProjectId")
    }
  }, [selectedProject]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedDatabase) {
      localStorage.setItem("selectedDatabaseId", selectedDatabase.id)
    } else {
      localStorage.removeItem("selectedDatabaseId")
    }
  }, [selectedDatabase])

  // Refresh projects when team changes
  useEffect(() => {
    if (selectedTeam) {
      setSelectedProject(null)
      setSelectedDatabase(null)
      refreshWorkspace()
    }
  }, [selectedTeam]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSetSelectedTeam = (team: Team | null) => {
    setSelectedTeam(team)
    setSelectedProject(null)
    setSelectedDatabase(null)
  }

  const handleSetSelectedProject = (project: Project | null) => {
    setSelectedProject(project)
    setSelectedDatabase(null)
  }

  return (
    <WorkspaceContext.Provider
      value={{
        selectedTeam,
        selectedProject,
        selectedDatabase,
        teams,
        projects,
        databases,
        setSelectedTeam: handleSetSelectedTeam,
        setSelectedProject: handleSetSelectedProject,
        setSelectedDatabase,
        refreshWorkspace,
        loading,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext)
  if (context === undefined) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider")
  }
  return context
}

