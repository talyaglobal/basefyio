"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Key, Plus, Trash2, Copy, Check, Eye, EyeOff } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

interface ApiKey {
  id: string
  name: string
  key: string
  created_at: string
  last_used: string | null
}

export function ApiKeyManager() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [isCreating, setIsCreating] = useState(false)
  const [newKeyName, setNewKeyName] = useState("")
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadApiKeys()
  }, [])

  const loadApiKeys = async () => {
    setLoading(true)
    setError("")
    try {
      const response = await fetch("/api/api-keys")
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      setApiKeys(data.keys)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load API keys")
    } finally {
      setLoading(false)
    }
  }

  const createApiKey = async () => {
    if (!newKeyName.trim()) {
      setError("Please enter a name for the API key")
      return
    }

    setLoading(true)
    setError("")
    try {
      const response = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error)

      setNewlyCreatedKey(data.key.key)
      await loadApiKeys()
      setNewKeyName("")
      setIsCreating(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create API key")
    } finally {
      setLoading(false)
    }
  }

  const deleteApiKey = async (id: string) => {
    if (!confirm("Are you sure you want to delete this API key? This action cannot be undone.")) return

    setLoading(true)
    setError("")
    try {
      const response = await fetch(`/api/api-keys/${id}`, {
        method: "DELETE",
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      await loadApiKeys()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete API key")
    } finally {
      setLoading(false)
    }
  }

  const copyToClipboard = (key: string, id: string) => {
    navigator.clipboard.writeText(key)
    setCopiedKey(id)
    setTimeout(() => setCopiedKey(null), 2000)
  }

  const toggleKeyVisibility = (id: string) => {
    setVisibleKeys((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(id)) {
        newSet.delete(id)
      } else {
        newSet.add(id)
      }
      return newSet
    })
  }

  const maskKey = (key: string) => {
    return key.substring(0, 8) + "..." + key.substring(key.length - 4)
  }

  return (
    <div className="space-y-4">
      {newlyCreatedKey && (
        <Alert>
          <AlertDescription>
            <div className="space-y-2">
              <p className="font-medium">API Key Created Successfully!</p>
              <p className="text-sm">Make sure to copy your API key now. You won't be able to see it again.</p>
              <div className="flex items-center gap-2 mt-2">
                <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono">{newlyCreatedKey}</code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(newlyCreatedKey)
                    setTimeout(() => setNewlyCreatedKey(null), 2000)
                  }}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Copy
                </Button>
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>API Keys</CardTitle>
              <CardDescription>
                {apiKeys.length} {apiKeys.length === 1 ? "key" : "keys"} active
              </CardDescription>
            </div>
            <Dialog open={isCreating} onOpenChange={setIsCreating}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Create API Key
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create New API Key</DialogTitle>
                  <DialogDescription>Give your API key a descriptive name to identify its purpose</DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="key-name">Key Name</Label>
                    <Input
                      id="key-name"
                      placeholder="e.g., Production API, Mobile App"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setIsCreating(false)}>
                    Cancel
                  </Button>
                  <Button onClick={createApiKey} disabled={loading || !newKeyName.trim()}>
                    {loading ? "Creating..." : "Create Key"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {loading && apiKeys.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">Loading API keys...</div>
          ) : apiKeys.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Key className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No API keys yet</p>
              <p className="text-sm mt-1">Create your first API key to get started</p>
            </div>
          ) : (
            <div className="space-y-3">
              {apiKeys.map((key) => (
                <div key={key.id} className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="font-medium">{key.name}</h4>
                      <Badge variant="secondary">Active</Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <code className="text-sm font-mono bg-muted px-2 py-1 rounded">
                        {visibleKeys.has(key.id) ? key.key : maskKey(key.key)}
                      </code>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleKeyVisibility(key.id)}
                        className="h-7 w-7 p-0"
                      >
                        {visibleKeys.has(key.id) ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyToClipboard(key.key, key.id)}
                        className="h-7 w-7 p-0"
                      >
                        {copiedKey === key.id ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      Created {new Date(key.created_at).toLocaleDateString()}
                      {key.last_used && ` • Last used ${new Date(key.last_used).toLocaleDateString()}`}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => deleteApiKey(key.id)} disabled={loading}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Using Your API Keys</CardTitle>
          <CardDescription>How to authenticate with your API keys</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <h4 className="text-sm font-medium mb-2">REST API</h4>
              <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
                <code>{`curl -H "Authorization: Bearer YOUR_API_KEY" \\
  https://api.kolaybase.com/v1/tables`}</code>
              </pre>
            </div>
            <div>
              <h4 className="text-sm font-medium mb-2">JavaScript</h4>
              <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
                <code>{`const response = await fetch('https://api.kolaybase.com/v1/tables', {
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY'
  }
});`}</code>
              </pre>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
