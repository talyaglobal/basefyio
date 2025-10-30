"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { GitBranch, Play, CheckCircle2, Clock, AlertCircle, Plus } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface Migration {
  id: string
  name: string
  version: string
  status: "pending" | "applied" | "failed"
  appliedAt?: string
  sql: string
}

export default function MigrationsPage() {
  const [migrations, setMigrations] = useState<Migration[]>([
    {
      id: "1",
      name: "Create users table",
      version: "001",
      status: "applied",
      appliedAt: "2024-01-15 10:30:00",
      sql: "CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255), email VARCHAR(255) UNIQUE);",
    },
    {
      id: "2",
      name: "Add posts table",
      version: "002",
      status: "applied",
      appliedAt: "2024-01-16 14:20:00",
      sql: "CREATE TABLE posts (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), title TEXT, content TEXT);",
    },
    {
      id: "3",
      name: "Add indexes",
      version: "003",
      status: "pending",
      sql: "CREATE INDEX idx_posts_user_id ON posts(user_id);",
    },
  ])
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [newMigration, setNewMigration] = useState({
    name: "",
    sql: "",
  })

  const handleCreateMigration = () => {
    const version = String(migrations.length + 1).padStart(3, "0")
    const migration: Migration = {
      id: Date.now().toString(),
      name: newMigration.name,
      version,
      status: "pending",
      sql: newMigration.sql,
    }
    setMigrations([...migrations, migration])
    setIsDialogOpen(false)
    setNewMigration({ name: "", sql: "" })
  }

  const handleRunMigration = (id: string) => {
    setMigrations(
      migrations.map((m) =>
        m.id === id ? { ...m, status: "applied" as const, appliedAt: new Date().toISOString() } : m,
      ),
    )
  }

  const pendingCount = migrations.filter((m) => m.status === "pending").length
  const appliedCount = migrations.filter((m) => m.status === "applied").length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Database Migrations</h1>
          <p className="text-muted-foreground mt-1">Manage and track database schema changes</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-green-600 hover:bg-green-700">
              <Plus className="h-4 w-4 mr-2" />
              New Migration
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Create Migration</DialogTitle>
              <DialogDescription>Write a new database migration script</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Migration Name</Label>
                <Input
                  placeholder="e.g., Add comments table"
                  value={newMigration.name}
                  onChange={(e) => setNewMigration({ ...newMigration, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>SQL Script</Label>
                <Textarea
                  placeholder="CREATE TABLE ..."
                  value={newMigration.sql}
                  onChange={(e) => setNewMigration({ ...newMigration, sql: e.target.value })}
                  className="font-mono text-sm min-h-[200px]"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateMigration} className="bg-green-600 hover:bg-green-700">
                Create Migration
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Migrations</p>
                <p className="text-3xl font-bold mt-1">{migrations.length}</p>
              </div>
              <GitBranch className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Applied</p>
                <p className="text-3xl font-bold mt-1 text-green-600">{appliedCount}</p>
              </div>
              <CheckCircle2 className="h-8 w-8 text-green-600" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Pending</p>
                <p className="text-3xl font-bold mt-1 text-orange-600">{pendingCount}</p>
              </div>
              <Clock className="h-8 w-8 text-orange-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Migration History</CardTitle>
          <CardDescription>View and manage all database migrations</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {migrations.map((migration, index) => (
              <Card key={migration.id}>
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div className="space-y-3 flex-1">
                      <div className="flex items-center gap-3">
                        <Badge variant="outline" className="font-mono">
                          v{migration.version}
                        </Badge>
                        <h3 className="font-semibold">{migration.name}</h3>
                        {migration.status === "applied" && (
                          <Badge className="bg-green-600">
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Applied
                          </Badge>
                        )}
                        {migration.status === "pending" && (
                          <Badge variant="secondary">
                            <Clock className="h-3 w-3 mr-1" />
                            Pending
                          </Badge>
                        )}
                        {migration.status === "failed" && (
                          <Badge variant="destructive">
                            <AlertCircle className="h-3 w-3 mr-1" />
                            Failed
                          </Badge>
                        )}
                      </div>
                      {migration.appliedAt && (
                        <p className="text-sm text-muted-foreground">Applied on {migration.appliedAt}</p>
                      )}
                      <pre className="bg-muted p-3 rounded text-xs overflow-auto">{migration.sql}</pre>
                    </div>
                    <div className="ml-4">
                      {migration.status === "pending" && (
                        <Button
                          size="sm"
                          onClick={() => handleRunMigration(migration.id)}
                          className="bg-green-600 hover:bg-green-700"
                        >
                          <Play className="h-4 w-4 mr-2" />
                          Run
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
