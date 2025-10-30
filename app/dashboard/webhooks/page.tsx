"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Webhook, Plus, Trash2, Edit, CheckCircle2, XCircle } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"

interface WebhookConfig {
  id: string
  name: string
  url: string
  events: string[]
  enabled: boolean
  lastTriggered?: string
  status: "success" | "failed" | "pending"
}

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([
    {
      id: "1",
      name: "User Registration",
      url: "https://api.example.com/webhooks/user-created",
      events: ["user.created"],
      enabled: true,
      lastTriggered: "2 hours ago",
      status: "success",
    },
    {
      id: "2",
      name: "Data Updates",
      url: "https://api.example.com/webhooks/data-updated",
      events: ["table.insert", "table.update"],
      enabled: true,
      lastTriggered: "5 minutes ago",
      status: "success",
    },
  ])
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [newWebhook, setNewWebhook] = useState({
    name: "",
    url: "",
    events: [] as string[],
  })

  const availableEvents = [
    "user.created",
    "user.updated",
    "user.deleted",
    "table.insert",
    "table.update",
    "table.delete",
    "auth.login",
    "auth.logout",
  ]

  const handleCreateWebhook = () => {
    const webhook: WebhookConfig = {
      id: Date.now().toString(),
      ...newWebhook,
      enabled: true,
      status: "pending",
    }
    setWebhooks([...webhooks, webhook])
    setIsDialogOpen(false)
    setNewWebhook({ name: "", url: "", events: [] })
  }

  const handleDeleteWebhook = (id: string) => {
    setWebhooks(webhooks.filter((w) => w.id !== id))
  }

  const toggleWebhook = (id: string) => {
    setWebhooks(webhooks.map((w) => (w.id === id ? { ...w, enabled: !w.enabled } : w)))
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Webhooks</h1>
          <p className="text-muted-foreground mt-1">Configure webhooks to receive real-time notifications</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-green-600 hover:bg-green-700">
              <Plus className="h-4 w-4 mr-2" />
              New Webhook
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Webhook</DialogTitle>
              <DialogDescription>Configure a new webhook endpoint to receive events</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Webhook Name</Label>
                <Input
                  placeholder="e.g., User Registration"
                  value={newWebhook.name}
                  onChange={(e) => setNewWebhook({ ...newWebhook, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Endpoint URL</Label>
                <Input
                  placeholder="https://api.example.com/webhook"
                  value={newWebhook.url}
                  onChange={(e) => setNewWebhook({ ...newWebhook, url: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Events</Label>
                <Select
                  onValueChange={(value) => {
                    if (!newWebhook.events.includes(value)) {
                      setNewWebhook({ ...newWebhook, events: [...newWebhook.events, value] })
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select events" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableEvents.map((event) => (
                      <SelectItem key={event} value={event}>
                        {event}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex flex-wrap gap-2 mt-2">
                  {newWebhook.events.map((event) => (
                    <Badge key={event} variant="secondary">
                      {event}
                      <button
                        onClick={() =>
                          setNewWebhook({ ...newWebhook, events: newWebhook.events.filter((e) => e !== event) })
                        }
                        className="ml-2 hover:text-destructive"
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateWebhook} className="bg-green-600 hover:bg-green-700">
                Create Webhook
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4">
        {webhooks.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <Webhook className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No webhooks configured</p>
              <p className="text-sm mt-2">Create a webhook to receive real-time notifications</p>
            </CardContent>
          </Card>
        ) : (
          webhooks.map((webhook) => (
            <Card key={webhook.id}>
              <CardContent className="pt-6">
                <div className="flex items-start justify-between">
                  <div className="space-y-3 flex-1">
                    <div className="flex items-center gap-3">
                      <h3 className="font-semibold text-lg">{webhook.name}</h3>
                      <Badge variant={webhook.enabled ? "default" : "secondary"}>
                        {webhook.enabled ? "Active" : "Disabled"}
                      </Badge>
                      {webhook.status === "success" && (
                        <Badge variant="outline" className="text-green-600">
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          Success
                        </Badge>
                      )}
                      {webhook.status === "failed" && (
                        <Badge variant="outline" className="text-red-600">
                          <XCircle className="h-3 w-3 mr-1" />
                          Failed
                        </Badge>
                      )}
                    </div>
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground min-w-[100px]">URL:</span>
                        <code className="bg-muted px-2 py-1 rounded text-xs">{webhook.url}</code>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-muted-foreground min-w-[100px]">Events:</span>
                        <div className="flex flex-wrap gap-1">
                          {webhook.events.map((event) => (
                            <Badge key={event} variant="outline" className="text-xs">
                              {event}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      {webhook.lastTriggered && (
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground min-w-[100px]">Last triggered:</span>
                          <span className="text-xs">{webhook.lastTriggered}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 items-center">
                    <Switch checked={webhook.enabled} onCheckedChange={() => toggleWebhook(webhook.id)} />
                    <Button variant="ghost" size="icon">
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDeleteWebhook(webhook.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
