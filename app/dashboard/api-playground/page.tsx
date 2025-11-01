"use client"

import { useState } from "react"
import { DatabaseRequired } from "@/components/database-required"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Play, Copy } from "lucide-react"

export default function APIPlaygroundPage() {
  const [method, setMethod] = useState("GET")
  const [endpoint, setEndpoint] = useState("/api/users")
  const [body, setBody] = useState("")
  const [response, setResponse] = useState("")
  const [loading, setLoading] = useState(false)

  const executeRequest = async () => {
    setLoading(true)
    try {
      // Simulate API call
      await new Promise((resolve) => setTimeout(resolve, 1000))
      setResponse(
        JSON.stringify(
          {
            status: 200,
            data: [
              { id: 1, name: "John Doe", email: "john@example.com" },
              { id: 2, name: "Jane Smith", email: "jane@example.com" },
            ],
          },
          null,
          2,
        ),
      )
    } catch (error) {
      setResponse(JSON.stringify({ error: "Request failed" }, null, 2))
    } finally {
      setLoading(false)
    }
  }

  const generateCode = (lang: string) => {
    const codes: Record<string, string> = {
      javascript: `fetch('${endpoint}', {
  method: '${method}',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_API_KEY'
  }${body ? `,\n  body: JSON.stringify(${body})` : ""}
})
  .then(res => res.json())
  .then(data => console.log(data))`,
      curl: `curl -X ${method} '${endpoint}' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer YOUR_API_KEY'${body ? ` \\\n  -d '${body}'` : ""}`,
      python: `import requests

response = requests.${method.toLowerCase()}(
    '${endpoint}',
    headers={
        'Content-Type': 'application/json',
        'Authorization': 'Bearer YOUR_API_KEY'
    }${body ? `,\n    json=${body}` : ""}
)
print(response.json())`,
    }
    return codes[lang] || ""
  }

  return (
    <DatabaseRequired message="Select or create a database to test API endpoints.">
      <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">API Playground</h1>
        <p className="text-muted-foreground mt-1">Test your API endpoints and generate code snippets</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Request</CardTitle>
            <CardDescription>Configure and send API requests</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                  <SelectItem value="PUT">PUT</SelectItem>
                  <SelectItem value="DELETE">DELETE</SelectItem>
                  <SelectItem value="PATCH">PATCH</SelectItem>
                </SelectContent>
              </Select>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                className="flex-1 px-3 py-2 border rounded-md bg-background"
                placeholder="/api/endpoint"
              />
            </div>

            {(method === "POST" || method === "PUT" || method === "PATCH") && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Request Body (JSON)</label>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder='{"key": "value"}'
                  className="font-mono text-sm min-h-[200px]"
                />
              </div>
            )}

            <Button onClick={executeRequest} disabled={loading} className="w-full bg-green-600 hover:bg-green-700">
              <Play className="h-4 w-4 mr-2" />
              {loading ? "Sending..." : "Send Request"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Response</CardTitle>
            <CardDescription>API response will appear here</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted p-4 rounded-md overflow-auto max-h-[400px] text-sm">
              {response || "No response yet"}
            </pre>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Code Generation</CardTitle>
          <CardDescription>Copy code snippets in your preferred language</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="javascript">
            <TabsList>
              <TabsTrigger value="javascript">JavaScript</TabsTrigger>
              <TabsTrigger value="curl">cURL</TabsTrigger>
              <TabsTrigger value="python">Python</TabsTrigger>
            </TabsList>
            <TabsContent value="javascript" className="space-y-2">
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(generateCode("javascript"))}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Copy
                </Button>
              </div>
              <pre className="bg-muted p-4 rounded-md overflow-auto text-sm">{generateCode("javascript")}</pre>
            </TabsContent>
            <TabsContent value="curl" className="space-y-2">
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(generateCode("curl"))}>
                  <Copy className="h-4 w-4 mr-2" />
                  Copy
                </Button>
              </div>
              <pre className="bg-muted p-4 rounded-md overflow-auto text-sm">{generateCode("curl")}</pre>
            </TabsContent>
            <TabsContent value="python" className="space-y-2">
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(generateCode("python"))}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Copy
                </Button>
              </div>
              <pre className="bg-muted p-4 rounded-md overflow-auto text-sm">{generateCode("python")}</pre>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      </div>
    </DatabaseRequired>
  )
}
