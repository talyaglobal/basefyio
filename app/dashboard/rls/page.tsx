"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Shield, Plus, Trash2, Edit, Play, History, ListPlus } from "lucide-react"
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
  const [policies, setPolicies] = useState<RLSPolicy[]>([])
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

  // Templates
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; description: string; type: string; expression: string; roles: string[] }>>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)

  // Simulator
  const [simTable, setSimTable] = useState("users")
  const [simExpression, setSimExpression] = useState("")
  const [simWhere, setSimWhere] = useState("")
  const [simResult, setSimResult] = useState<{ allowed: boolean; matchedRows: number; plan?: any } | null>(null)
  const [simLoading, setSimLoading] = useState(false)

  // Audit
  const [audit, setAudit] = useState<Array<{ id: string; table_name: string; policy_name: string; action: string; created_by: string; created_at: string }>>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditFilterTable, setAuditFilterTable] = useState<string>("")
  const [auditFilterPolicy, setAuditFilterPolicy] = useState<string>("")

  const tables = ["users", "posts", "comments", "profiles"]

  // Load policies (basic: filter via /api/rls?table=...)
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const res = await fetch(`/api/rls?table=${encodeURIComponent(selectedTable)}`)
        const json = await res.json()
        if (!res.ok) throw new Error(json?.message || "Failed to load policies")
        if (!active) return
        const mapped: RLSPolicy[] = (json.policies || []).map((p: any) => ({
          id: `${p.tablename}:${p.policyname}`,
          name: p.policyname,
          table: p.tablename,
          command: (p.cmd || "ALL") as RLSPolicy["command"],
          role: Array.isArray(p.roles) && p.roles.length ? p.roles.join(",") : "public",
          using: p.qual || "",
          withCheck: p.with_check || "",
          enabled: true,
        }))
        setPolicies(mapped)
      } catch (e) {
        setPolicies([])
      }
    }
    load()
    return () => { active = false }
  }, [selectedTable])

  // Load templates once
  useEffect(() => {
    let active = true
    const load = async () => {
      setTemplatesLoading(true)
      try {
        const res = await fetch("/api/rls/templates")
        const json = await res.json()
        if (!res.ok) throw new Error(json?.message || "Failed to load templates")
        if (active) setTemplates(json.templates || [])
      } catch {
        if (active) setTemplates([])
      } finally {
        if (active) setTemplatesLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [])

  // Load audit on mount and when filters change
  const reloadAudit = async () => {
    setAuditLoading(true)
    try {
      const params = new URLSearchParams()
      if (auditFilterTable) params.set("table", auditFilterTable)
      if (auditFilterPolicy) params.set("policy", auditFilterPolicy)
      const res = await fetch(`/api/rls/audit?${params.toString()}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json?.message || "Failed to load audit")
      setAudit(json.events || [])
    } catch {
      setAudit([])
    } finally {
      setAuditLoading(false)
    }
  }
  useEffect(() => {
    reloadAudit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditFilterTable, auditFilterPolicy])

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

      {/* Templates */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2"><ListPlus className="h-4 w-4" /> Policy templates</CardTitle>
              <CardDescription>Quickly start from a best-practice policy</CardDescription>
            </div>
            <Button variant="outline" onClick={() => {
              // reload templates
              (async () => {
                setTemplatesLoading(true)
                try {
                  const res = await fetch("/api/rls/templates")
                  const json = await res.json()
                  if (!res.ok) throw new Error()
                  setTemplates(json.templates || [])
                } finally { setTemplatesLoading(false) }
              })()
            }}>Refresh</Button>
          </div>
        </CardHeader>
        <CardContent>
          {templatesLoading ? (
            <p className="text-sm text-muted-foreground">Loading templates…</p>
          ) : (
            <div className="grid md:grid-cols-3 gap-4">
              {templates.map((t) => (
                <Card key={t.id}>
                  <CardHeader>
                    <CardTitle className="text-base">{t.name}</CardTitle>
                    <CardDescription>{t.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between gap-2">
                    <code className="bg-muted px-2 py-1 rounded text-xs overflow-auto">{t.expression}</code>
                    <Button size="sm" onClick={() => {
                      setNewPolicy({
                        name: t.id,
                        table: selectedTable,
                        command: (t.type as any) || "ALL",
                        role: (t.roles && t.roles[0]) || "public",
                        using: t.expression,
                        withCheck: t.type === "INSERT" || t.type === "ALL" ? t.expression : "",
                      })
                      setIsDialogOpen(true)
                    }}>Use</Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Simulator */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2"><Play className="h-4 w-4" /> Policy simulator</CardTitle>
              <CardDescription>Check if an expression would match any rows</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Table</Label>
              <Select value={simTable} onValueChange={setSimTable}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tables.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Expression (USING)</Label>
              <Textarea className="font-mono text-sm" placeholder="auth.uid() = user_id" value={simExpression} onChange={(e) => setSimExpression(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Additional WHERE (optional)</Label>
            <Textarea className="font-mono text-sm" placeholder="status = 'published'" value={simWhere} onChange={(e) => setSimWhere(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <Button disabled={simLoading || !simExpression.trim()} onClick={async () => {
              setSimLoading(true)
              setSimResult(null)
              try {
                const res = await fetch("/api/rls/simulate", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ table: simTable, expression: simExpression, where: simWhere || undefined, limit: 1 }),
                })
                const json = await res.json()
                if (!res.ok) throw new Error(json?.message || "Simulation failed")
                setSimResult(json)
              } catch (e) {
                setSimResult({ allowed: false, matchedRows: 0 })
              } finally {
                setSimLoading(false)
              }
            }}>
              <Play className="h-4 w-4 mr-2" /> Run simulation
            </Button>
            {simResult && (
              <Badge variant={simResult.allowed ? "default" : "secondary"}>
                {simResult.allowed ? "Matches rows" : "No match"}
              </Badge>
            )}
          </div>
          {simResult?.plan && (
            <div className="mt-2 text-xs text-muted-foreground overflow-auto">
              <pre className="whitespace-pre-wrap">{JSON.stringify(simResult.plan, null, 2)}</pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Audit timeline */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2"><History className="h-4 w-4" /> Policy audit</CardTitle>
              <CardDescription>Recent changes to RLS policies</CardDescription>
            </div>
            <div className="flex gap-2">
              <Input placeholder="Filter table" value={auditFilterTable} onChange={(e) => setAuditFilterTable(e.target.value)} className="w-[180px]" />
              <Input placeholder="Filter policy" value={auditFilterPolicy} onChange={(e) => setAuditFilterPolicy(e.target.value)} className="w-[200px]" />
              <Button variant="outline" onClick={reloadAudit}>Refresh</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {auditLoading ? (
            <p className="text-sm text-muted-foreground">Loading audit…</p>
          ) : audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">No audit events.</p>
          ) : (
            <div className="space-y-3">
              {audit.map((e) => (
                <div key={e.id} className="flex items-center justify-between border rounded p-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm">
                      <Badge variant="outline">{e.action}</Badge>
                      <code className="bg-muted px-2 py-0.5 rounded">{e.table_name}:{e.policy_name}</code>
                    </div>
                    <div className="text-xs text-muted-foreground">by {e.created_by} • {new Date(e.created_at).toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
