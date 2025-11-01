"use client"

import { useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ChevronDown, Plus, Building2, FolderOpen, Database, Loader2 } from "lucide-react"
import { Team, Project, Database as DatabaseType } from "@/types"
import { useWorkspace } from "@/components/workspace-context"
import { useToast } from "@/hooks/use-toast"

interface TeamProjectSelectorProps {
  selectedTeam: Team | null
  selectedProject: Project | null
  selectedDatabase: DatabaseType | null
  teams: Team[]
  projects: Project[]
  databases: DatabaseType[]
  onTeamChange: (team: Team | null) => void
  onProjectChange: (project: Project | null) => void
  onDatabaseChange: (database: DatabaseType | null) => void
}

export function TeamProjectSelector({
  selectedTeam,
  selectedProject,
  selectedDatabase,
  teams,
  projects,
  databases,
  onTeamChange,
  onProjectChange,
  onDatabaseChange,
}: TeamProjectSelectorProps) {
  const workspace = useWorkspace()
  const { toast } = useToast()
  const [isCreatingTeam, setIsCreatingTeam] = useState(false)
  const [isCreatingProject, setIsCreatingProject] = useState(false)
  const [isCreatingDatabase, setIsCreatingDatabase] = useState(false)
  const [loading, setLoading] = useState(false)

  // Team creation
  const [newTeamName, setNewTeamName] = useState("")
  const handleCreateTeam = async () => {
    if (!newTeamName.trim()) return
    
    setLoading(true)
    try {
      const res = await fetch("/api/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTeamName }),
      })
      
      const data = await res.json()
      
      if (res.ok && data.team) {
        // Select the newly created team immediately
        onTeamChange(data.team)
        
        setNewTeamName("")
        setIsCreatingTeam(false)
        
        // Refresh workspace in background to update the teams list
        workspace.refreshWorkspace().catch((err) => {
          console.error("Error refreshing workspace:", err)
        })
        
        toast({
          title: "Team created",
          description: `${newTeamName} has been created successfully.`,
        })
      } else {
        // Show error message
        const errorMessage = data.error || data.message || "Failed to create team"
        toast({
          title: "Error",
          description: errorMessage,
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Error creating team:", error)
      toast({
        title: "Error",
        description: "An unexpected error occurred while creating the team.",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  // Project creation
  const [newProjectName, setNewProjectName] = useState("")
  const [newProjectDescription, setNewProjectDescription] = useState("")
  const handleCreateProject = async () => {
    if (!newProjectName.trim() || !selectedTeam) return
    
    setLoading(true)
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newProjectName,
          team_id: selectedTeam.id,
          description: newProjectDescription || undefined,
        }),
      })
      
      const data = await res.json()
      
      if (res.ok && data.project) {
        // Select the newly created project immediately
        onProjectChange(data.project)
        
        setNewProjectName("")
        setNewProjectDescription("")
        setIsCreatingProject(false)
        
        // Refresh workspace in background to update the projects list
        workspace.refreshWorkspace().catch((err) => {
          console.error("Error refreshing workspace:", err)
        })
        
        toast({
          title: "Project created",
          description: `${newProjectName} has been created successfully.`,
        })
      } else {
        const errorMessage = data.error || data.message || "Failed to create project"
        toast({
          title: "Error",
          description: errorMessage,
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Error creating project:", error)
      toast({
        title: "Error",
        description: "An unexpected error occurred while creating the project.",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  // Database creation
  const [newDatabaseName, setNewDatabaseName] = useState("")
  const [newDatabaseDescription, setNewDatabaseDescription] = useState("")
  const [newDatabaseUrl, setNewDatabaseUrl] = useState("")
  const [newDatabaseProvider, setNewDatabaseProvider] = useState<"postgres" | "neon" | "supabase">("postgres")
  const handleCreateDatabase = async () => {
    if (!newDatabaseName.trim() || !selectedProject || !newDatabaseUrl.trim()) return
    
    setLoading(true)
    try {
      const res = await fetch("/api/databases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newDatabaseName,
          project_id: selectedProject.id,
          description: newDatabaseDescription || undefined,
          database_url: newDatabaseUrl,
          provider: newDatabaseProvider,
        }),
      })
      
      const data = await res.json()
      
      if (res.ok && data.database) {
        // Select the newly created database immediately
        onDatabaseChange(data.database)
        
        setNewDatabaseName("")
        setNewDatabaseDescription("")
        setNewDatabaseUrl("")
        setIsCreatingDatabase(false)
        
        // Refresh workspace in background to update the databases list
        workspace.refreshWorkspace().catch((err) => {
          console.error("Error refreshing workspace:", err)
        })
        
        toast({
          title: "Database created",
          description: `${newDatabaseName} has been created successfully.`,
        })
      } else {
        const errorMessage = data.error || data.message || "Failed to create database"
        toast({
          title: "Error",
          description: errorMessage,
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Error creating database:", error)
      toast({
        title: "Error",
        description: "An unexpected error occurred while creating the database.",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  // Filter projects and databases based on selections
  const filteredProjects = selectedTeam
    ? projects.filter((p) => p.org_id === selectedTeam.id)
    : []
  
  const filteredDatabases = selectedProject
    ? databases.filter((d) => d.project_id === selectedProject.id)
    : []

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Team Selector */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <Building2 className="h-4 w-4" />
            <span className="hidden sm:inline">
              {selectedTeam ? selectedTeam.name : "Select Team"}
            </span>
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Teams</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {teams.map((team) => (
            <DropdownMenuItem
              key={team.id}
              onClick={() => {
                onTeamChange(team)
                onProjectChange(null)
                onDatabaseChange(null)
              }}
            >
              {team.name}
              {selectedTeam?.id === team.id && (
                <Badge variant="secondary" className="ml-2">Active</Badge>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <Dialog open={isCreatingTeam} onOpenChange={setIsCreatingTeam}>
            <DialogTrigger asChild>
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <Plus className="h-4 w-4 mr-2" />
                New Team
              </DropdownMenuItem>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Team</DialogTitle>
                <DialogDescription>
                  Create a new team to organize your projects and collaborate with others.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="team-name">Team Name</Label>
                  <Input
                    id="team-name"
                    placeholder="e.g., TSmart Energy"
                    value={newTeamName}
                    onChange={(e) => setNewTeamName(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsCreatingTeam(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreateTeam} disabled={loading || !newTeamName.trim()}>
                  {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Create Team
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Project Selector */}
      {selectedTeam && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2" disabled={!selectedTeam}>
              <FolderOpen className="h-4 w-4" />
              <span className="hidden sm:inline">
                {selectedProject ? selectedProject.name : "Select Project"}
              </span>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Projects</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {filteredProjects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onClick={() => {
                  onProjectChange(project)
                  onDatabaseChange(null)
                }}
              >
                {project.name}
                {selectedProject?.id === project.id && (
                  <Badge variant="secondary" className="ml-2">Active</Badge>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <Dialog open={isCreatingProject} onOpenChange={setIsCreatingProject}>
              <DialogTrigger asChild>
                <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                  <Plus className="h-4 w-4 mr-2" />
                  New Project
                </DropdownMenuItem>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create New Project</DialogTitle>
                  <DialogDescription>
                    Create a new project in {selectedTeam?.name}.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="project-name">Project Name</Label>
                    <Input
                      id="project-name"
                      placeholder="e.g., Battery Management Platform"
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="project-description">Description (Optional)</Label>
                    <Textarea
                      id="project-description"
                      placeholder="Project description..."
                      value={newProjectDescription}
                      onChange={(e) => setNewProjectDescription(e.target.value)}
                      rows={3}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsCreatingProject(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreateProject} disabled={loading || !newProjectName.trim()}>
                    {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Create Project
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Database Selector */}
      {selectedProject && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2" disabled={!selectedProject}>
              <Database className="h-4 w-4" />
              <span className="hidden sm:inline">
                {selectedDatabase ? selectedDatabase.name : "Select Database"}
              </span>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Databases</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {filteredDatabases.map((database) => (
              <DropdownMenuItem
                key={database.id}
                onClick={() => onDatabaseChange(database)}
              >
                {database.name}
                <Badge variant={database.status === "active" ? "default" : "secondary"} className="ml-2">
                  {database.status}
                </Badge>
                {selectedDatabase?.id === database.id && (
                  <Badge variant="outline" className="ml-2">Active</Badge>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <Dialog open={isCreatingDatabase} onOpenChange={setIsCreatingDatabase}>
              <DialogTrigger asChild>
                <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                  <Plus className="h-4 w-4 mr-2" />
                  New Database
                </DropdownMenuItem>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create New Database</DialogTitle>
                  <DialogDescription>
                    Create a new database in {selectedProject?.name}.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="database-name">Database Name</Label>
                    <Input
                      id="database-name"
                      placeholder="e.g., production_db"
                      value={newDatabaseName}
                      onChange={(e) => setNewDatabaseName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="database-description">Description (Optional)</Label>
                    <Textarea
                      id="database-description"
                      placeholder="Database description..."
                      value={newDatabaseDescription}
                      onChange={(e) => setNewDatabaseDescription(e.target.value)}
                      rows={2}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="database-url">Database URL</Label>
                    <Input
                      id="database-url"
                      placeholder="postgresql://user:password@host:port/dbname"
                      value={newDatabaseUrl}
                      onChange={(e) => setNewDatabaseUrl(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="database-provider">Provider</Label>
                    <Select value={newDatabaseProvider} onValueChange={(v: any) => setNewDatabaseProvider(v)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="postgres">PostgreSQL</SelectItem>
                        <SelectItem value="neon">Neon</SelectItem>
                        <SelectItem value="supabase">Supabase</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsCreatingDatabase(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handleCreateDatabase}
                    disabled={loading || !newDatabaseName.trim() || !newDatabaseUrl.trim()}
                  >
                    {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Create Database
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

