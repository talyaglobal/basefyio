"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Shield, Plus, Trash2, Edit } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

interface RLSPolicy {
  id: string
  name: string
  table: string
  command: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL"
  role: string
  using: string
  withCheck?: string
  enabled: boolean
}

export default function RLSPage() {
  const [policies, setPolicies] = useState<RLSPolicy[]>([
    {
      id: "1",
      name: "users_select_own",
      table: "users",
      command: "SELECT",
      role: "authenticated",
      using: "auth.uid() = id",
      enabled: true,
    },
    {
      id: "2",
      name: "posts_insert_own",
      table: "posts",
      command: "INSERT",
      role: "authenticated",
      using: "auth.uid() = user_id",
      withCheck: "auth.uid() = user_id",
      enabled: true,
    },
  ])
  const [selectedTable, setSelectedTable] = useState("users")
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [newPolicy, setNewPolicy] = useState({
    name: "",
    table: "users",
    command: "SELECT" as const,
    role: "authenticated",
    using: "",
    withCheck: "",
  })

  const tables = ["users", "posts", "comments", "profiles"]

  const handleCreatePolicy = () => {
    const policy: RLSPolicy = {
      id: Date.now().toString(),
      ...newPolicy,
      enabled: true,
    }
    setPolicies([...policies, policy])
    setIsDialogOpen(false)
    setNewPolicy({
      name: "",
      table: "users",
      command: "SELECT",
      role: "authenticated",
      using: "",
      withCheck: "",
    })
  }

  const handleDeletePolicy = (id: string) => {
    setPolicies(policies.filter((p) => p.id !== id))
  }

  const filteredPolicies = policies.filter((p) => p.table === selectedTable)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Row Level Security</h1>
          <p className="text-muted-foreground mt-1">Manage RLS policies to control data access at the row level</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-green-600 hover:bg-green-700">
              <Plus className="h-4 w-4 mr-2" />
              New Policy
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Create RLS Policy</DialogTitle>
              <DialogDescription>Define a new row level security policy for your table</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Policy Name</Label>
                  <Input
                    placeholder="e.g., users_select_own"
                    value={newPolicy.name}
                    onChange={(e) => setNewPolicy({ ...newPolicy, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Table</Label>
                  <Select
                    value={newPolicy.table}
                    onValueChange={(value) => setNewPolicy({ ...newPolicy, table: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {tables.map((table) => (
                        <SelectItem key={table} value={table}>
                          {table}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Command</Label>
                  <Select
                    value={newPolicy.command}
                    onValueChange={(value: any) => setNewPolicy({ ...newPolicy, command: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SELECT">SELECT</SelectItem>
                      <SelectItem value="INSERT">INSERT</SelectItem>
                      <SelectItem value="UPDATE">UPDATE</SelectItem>
                      <SelectItem value="DELETE">DELETE</SelectItem>
                      <SelectItem value="ALL">ALL</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Role</Label>
                  <Input
                    placeholder="e.g., authenticated"
                    value={newPolicy.role}
                    onChange={(e) => setNewPolicy({ ...newPolicy, role: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>USING Expression</Label>
                <Textarea
                  placeholder="e.g., auth.uid() = user_id"
                  value={newPolicy.using}
                  onChange={(e) => setNewPolicy({ ...newPolicy, using: e.target.value })}
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label>WITH CHECK Expression (optional)</Label>
                <Textarea
                  placeholder="e.g., auth.uid() = user_id"
                  value={newPolicy.withCheck}
                  onChange={(e) => setNewPolicy({ ...newPolicy, withCheck: e.target.value })}
                  className="font-mono text-sm"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreatePolicy} className="bg-green-600 hover:bg-green-700">
                Create Policy
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Policies</CardTitle>
              <CardDescription>Select a table to view and manage its RLS policies</CardDescription>
            </div>
            <Select value={selectedTable} onValueChange={setSelectedTable}>
              <SelectTrigger className="w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tables.map((table) => (
                  <SelectItem key={table} value={table}>
                    {table}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {filteredPolicies.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Shield className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No RLS policies found for this table</p>
                <p className="text-sm mt-2">Create a policy to control row-level access</p>
              </div>
            ) : (
              filteredPolicies.map((policy) => (
                <Card key={policy.id}>
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between">
                      <div className="space-y-3 flex-1">
                        <div className="flex items-center gap-3">
                          <h3 className="font-semibold text-lg">{policy.name}</h3>
                          <Badge variant={policy.enabled ? "default" : "secondary"}>
                            {policy.enabled ? "Enabled" : "Disabled"}
                          </Badge>
                          <Badge variant="outline">{policy.command}</Badge>
                        </div>
                        <div className="space-y-2 text-sm">
                          <div className="flex items-start gap-2">
                            <span className="text-muted-foreground min-w-[100px]">Role:</span>
                            <code className="bg-muted px-2 py-1 rounded">{policy.role}</code>
                          </div>
                          <div className="flex items-start gap-2">
                            <span className="text-muted-foreground min-w-[100px]">USING:</span>
                            <code className="bg-muted px-2 py-1 rounded flex-1">{policy.using}</code>
                          </div>
                          {policy.withCheck && (
                            <div className="flex items-start gap-2">
                              <span className="text-muted-foreground min-w-[100px]">WITH CHECK:</span>
                              <code className="bg-muted px-2 py-1 rounded flex-1">{policy.withCheck}</code>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="icon">
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDeletePolicy(policy.id)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
