"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Play, Copy, Check, Zap } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"

export function GraphQLExplorer() {
  const [query, setQuery] = useState(`query GetUsers {
  users {
    id
    email
    created_at
  }
}`)
  const [variables, setVariables] = useState("{}")
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [activeTab, setActiveTab] = useState("query")

  // Realtime connection state
  const [realtimeConnected, setRealtimeConnected] = useState(false)
  const [realtimeMessages, setRealtimeMessages] = useState<any[]>([])
  const [subscriptionQuery, setSubscriptionQuery] = useState(`subscription OnUserCreated {
  userCreated {
    id
    email
    created_at
  }
}`)

  const executeQuery = async () => {
    setLoading(true)
    setError("")
    setResult(null)

    try {
      const response = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          variables: JSON.parse(variables || "{}"),
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "GraphQL request failed")
      }

      if (data.errors) {
        throw new Error(data.errors[0].message)
      }

      setResult(data.data)
      setActiveTab("response")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to execute query")
    } finally {
      setLoading(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const toggleRealtime = () => {
    if (realtimeConnected) {
      setRealtimeConnected(false)
      setRealtimeMessages([])
    } else {
      setRealtimeConnected(true)
      // Simulate realtime connection
      setRealtimeMessages([
        {
          timestamp: new Date().toISOString(),
          type: "connection",
          message: "Connected to realtime server",
        },
      ])
    }
  }

  const exampleQueries = [
    {
      name: "Get All Users",
      query: `query GetUsers {
  users {
    id
    email
    created_at
  }
}`,
    },
    {
      name: "Get User by ID",
      query: `query GetUser($id: ID!) {
  user(id: $id) {
    id
    email
    created_at
  }
}`,
      variables: `{
  "id": "1"
}`,
    },
    {
      name: "Create User",
      query: `mutation CreateUser($email: String!, $password: String!) {
  createUser(email: $email, password: $password) {
    id
    email
    created_at
  }
}`,
      variables: `{
  "email": "new@example.com",
  "password": "password123"
}`,
    },
  ]

  return (
    <div className="space-y-4">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="query">Query</TabsTrigger>
          <TabsTrigger value="response">Response</TabsTrigger>
          <TabsTrigger value="realtime">Realtime</TabsTrigger>
          <TabsTrigger value="schema">Schema</TabsTrigger>
        </TabsList>

        <TabsContent value="query" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>GraphQL Query</CardTitle>
                  <CardDescription>Write your GraphQL query or mutation</CardDescription>
                </div>
                <div className="flex gap-2">
                  {exampleQueries.map((ex, i) => (
                    <Button
                      key={i}
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setQuery(ex.query)
                        if (ex.variables) setVariables(ex.variables)
                      }}
                    >
                      {ex.name}
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Query</label>
                <Textarea
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Enter your GraphQL query..."
                  className="font-mono min-h-[200px] text-sm"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Variables (JSON)</label>
                <Textarea
                  value={variables}
                  onChange={(e) => setVariables(e.target.value)}
                  placeholder='{"key": "value"}'
                  className="font-mono min-h-[100px] text-sm"
                />
              </div>
              <Button onClick={executeQuery} disabled={loading || !query.trim()}>
                <Play className="h-4 w-4 mr-2" />
                {loading ? "Executing..." : "Execute Query"}
              </Button>
            </CardContent>
          </Card>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </TabsContent>

        <TabsContent value="response">
          {result ? (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Response</CardTitle>
                    <CardDescription>GraphQL query result</CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => copyToClipboard(JSON.stringify(result, null, 2))}>
                    {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                    {copied ? "Copied!" : "Copy"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
                  <code>{JSON.stringify(result, null, 2)}</code>
                </pre>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <Play className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>Execute a query to see the response here</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="realtime" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Realtime Subscriptions</CardTitle>
                  <CardDescription>Test realtime GraphQL subscriptions</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={realtimeConnected ? "default" : "secondary"}>
                    {realtimeConnected ? "Connected" : "Disconnected"}
                  </Badge>
                  <Button variant={realtimeConnected ? "destructive" : "default"} size="sm" onClick={toggleRealtime}>
                    <Zap className="h-4 w-4 mr-2" />
                    {realtimeConnected ? "Disconnect" : "Connect"}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Subscription Query</label>
                <Textarea
                  value={subscriptionQuery}
                  onChange={(e) => setSubscriptionQuery(e.target.value)}
                  placeholder="Enter your GraphQL subscription..."
                  className="font-mono min-h-[150px] text-sm"
                  disabled={realtimeConnected}
                />
              </div>

              <div className="border rounded-lg p-4 bg-muted/30 min-h-[200px]">
                <h4 className="text-sm font-medium mb-3">Messages</h4>
                {realtimeMessages.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No messages yet. Connect to start receiving updates.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {realtimeMessages.map((msg, i) => (
                      <div key={i} className="text-sm border-l-2 border-primary pl-3 py-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                          <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                          <Badge variant="outline" className="text-xs">
                            {msg.type}
                          </Badge>
                        </div>
                        <div className="font-mono text-xs">{msg.message}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="schema">
          <Card>
            <CardHeader>
              <CardTitle>GraphQL Schema</CardTitle>
              <CardDescription>Available types and operations</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
                <code>{`type User {
  id: ID!
  email: String!
  created_at: String!
}

type Query {
  users: [User!]!
  user(id: ID!): User
}

type Mutation {
  createUser(email: String!, password: String!): User!
  updateUser(id: ID!, email: String): User!
  deleteUser(id: ID!): Boolean!
}

type Subscription {
  userCreated: User!
  userUpdated: User!
  userDeleted: ID!
}`}</code>
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
