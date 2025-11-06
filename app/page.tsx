import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      {/* Hero Section */}
      <div className="flex flex-col items-center justify-center p-4 py-16">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-5xl font-bold text-gray-900 mb-6">
            Welcome to <span className="text-blue-600">Kolaybase</span>
          </h1>
          <p className="text-xl text-gray-600 mb-8 max-w-2xl mx-auto">
            A powerful PostgreSQL database management platform. Build, manage, and scale your applications with ease.
          </p>
          <div className="flex gap-4 justify-center">
            <Link href="/sign-up">
              <Button size="lg" className="px-8">
                Get Started
              </Button>
            </Link>
            <Link href="/sign-in">
              <Button variant="outline" size="lg" className="px-8">
                Sign In
              </Button>
            </Link>
          </div>
          
          <div className="mt-16 grid md:grid-cols-3 gap-8">
            <div className="bg-white p-6 rounded-lg shadow-sm">
              <h3 className="text-lg font-semibold mb-2">Database Management</h3>
              <p className="text-gray-600">Create, manage, and query your PostgreSQL databases with an intuitive interface.</p>
            </div>
            <div className="bg-white p-6 rounded-lg shadow-sm">
              <h3 className="text-lg font-semibold mb-2">API Generation</h3>
              <p className="text-gray-600">Automatically generate REST and GraphQL APIs from your database schema.</p>
            </div>
            <div className="bg-white p-6 rounded-lg shadow-sm">
              <h3 className="text-lg font-semibold mb-2">Real-time Updates</h3>
              <p className="text-gray-600">Get real-time updates and notifications for your database changes.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Developer Documentation Section */}
      <div className="max-w-6xl mx-auto px-4 pb-16">
        <div className="bg-white rounded-xl shadow-lg p-8">
          <h2 className="text-3xl font-bold text-gray-900 mb-2">Developer Documentation</h2>
          <p className="text-gray-600 mb-8">
            Get started with Kolaybase API in minutes. Everything you need to build powerful applications.
          </p>

          <Tabs defaultValue="quickstart" className="w-full">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="quickstart">Quick Start</TabsTrigger>
              <TabsTrigger value="authentication">Authentication</TabsTrigger>
              <TabsTrigger value="api">API Examples</TabsTrigger>
              <TabsTrigger value="realtime">Real-time</TabsTrigger>
            </TabsList>

            <TabsContent value="quickstart" className="mt-6">
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Installation</CardTitle>
                    <CardDescription>Get started with Kolaybase in your project</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      <div>
                        <h4 className="font-semibold mb-2">1. Install Dependencies</h4>
                        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                          <code>{`npm install
# or
yarn install`}</code>
                        </pre>
                      </div>
                      <div>
                        <h4 className="font-semibold mb-2">2. Set Environment Variables</h4>
                        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                          <code>{`DATABASE_URL=postgresql://user:pass@host:5432/db
JWT_SECRET=your_secret_key
NEXT_PUBLIC_BASE_URL=http://localhost:3000`}</code>
                        </pre>
                      </div>
                      <div>
                        <h4 className="font-semibold mb-2">3. Initialize Database</h4>
                        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                          <code>{`npm run db:setup`}</code>
                        </pre>
                      </div>
                      <div>
                        <h4 className="font-semibold mb-2">4. Start Development Server</h4>
                        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                          <code>{`npm run dev`}</code>
                        </pre>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Default Credentials</CardTitle>
                    <CardDescription>After setup, use these credentials to sign in</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <p className="text-sm text-yellow-800">
                        <strong>Email:</strong> admin@kolaybase.com<br />
                        <strong>Password:</strong> admin123
                      </p>
                      <p className="text-xs text-yellow-700 mt-2">
                        ⚠️ Remember to change this password in production!
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="authentication" className="mt-6">
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Session Authentication</CardTitle>
                    <CardDescription>Authenticate using email and password</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                      <code>{`// Sign in
const response = await fetch('/api/auth/sign-in', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'user@example.com',
    password: 'password'
  })
});

const { token, user } = await response.json();

// Use token in subsequent requests
fetch('/api/tables', {
  headers: {
    'Authorization': \`Bearer \${token}\`
  }
});`}</code>
                    </pre>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>API Key Authentication</CardTitle>
                    <CardDescription>Create and use API keys for programmatic access</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      <div>
                        <h4 className="font-semibold mb-2">Create API Key</h4>
                        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                          <code>{`const response = await fetch('/api/api-keys', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer SESSION_TOKEN',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'My App Key',
    scopes: ['read:tables', 'write:tables'],
    expiresAt: '2024-12-31T23:59:59Z'
  })
});

const { apiKey } = await response.json();
// Save apiKey.key securely - it won't be shown again!`}</code>
                        </pre>
                      </div>
                      <div>
                        <h4 className="font-semibold mb-2">Use API Key</h4>
                        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                          <code>{`fetch('/api/tables', {
  headers: {
    'Authorization': \`Bearer \${apiKey}\`
  }
});`}</code>
                        </pre>
                      </div>
                      <div className="mt-4">
                        <h4 className="font-semibold mb-2">Available Scopes</h4>
                        <ul className="list-disc list-inside space-y-1 text-sm text-gray-600">
                          <li><code className="bg-gray-100 px-1 rounded">read:tables</code> - Read table data</li>
                          <li><code className="bg-gray-100 px-1 rounded">write:tables</code> - Modify table data</li>
                          <li><code className="bg-gray-100 px-1 rounded">read:schema</code> - View database schema</li>
                          <li><code className="bg-gray-100 px-1 rounded">write:schema</code> - Modify database schema</li>
                          <li><code className="bg-gray-100 px-1 rounded">read:files</code> - Access file storage</li>
                          <li><code className="bg-gray-100 px-1 rounded">write:files</code> - Upload/modify files</li>
                          <li><code className="bg-gray-100 px-1 rounded">admin</code> - Full administrative access</li>
                        </ul>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="api" className="mt-6">
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Query Data</CardTitle>
                    <CardDescription>Fetch rows from your tables</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                      <code>{`// Get all tables
const tables = await fetch('/api/tables', {
  headers: { 'Authorization': 'Bearer API_KEY' }
}).then(r => r.json());

// Get table rows with pagination
const rows = await fetch(
  '/api/tables/users/rows?limit=100&offset=0',
  {
    headers: { 'Authorization': 'Bearer API_KEY' }
  }
).then(r => r.json());

// Filter and sort
const filtered = await fetch(
  '/api/tables/users/rows?filter={"active":true}&sort=created_at&order=desc',
  {
    headers: { 'Authorization': 'Bearer API_KEY' }
  }
).then(r => r.json());`}</code>
                    </pre>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Insert Data</CardTitle>
                    <CardDescription>Add new rows to your tables</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                      <code>{`const response = await fetch('/api/tables/users/rows', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    email: 'user@example.com',
    name: 'John Doe',
    active: true
  })
});

const { row } = await response.json();`}</code>
                    </pre>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Update & Delete</CardTitle>
                    <CardDescription>Modify or remove existing rows</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      <div>
                        <h4 className="font-semibold mb-2">Update Row</h4>
                        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                          <code>{`await fetch('/api/tables/users/rows', {
  method: 'PATCH',
  headers: {
    'Authorization': 'Bearer API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    filter: { id: 1 },
    data: { name: 'Updated Name' }
  })
});`}</code>
                        </pre>
                      </div>
                      <div>
                        <h4 className="font-semibold mb-2">Delete Row</h4>
                        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                          <code>{`await fetch('/api/tables/users/rows', {
  method: 'DELETE',
  headers: {
    'Authorization': 'Bearer API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    filter: { id: 1 }
  })
});`}</code>
                        </pre>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Execute SQL</CardTitle>
                    <CardDescription>Run custom SQL queries</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                      <code>{`const result = await fetch('/api/sql/execute', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    sql: 'SELECT * FROM users WHERE active = $1',
    params: [true]
  })
}).then(r => r.json());

console.log(result.rows); // Array of results
console.log(result.rowCount); // Number of rows`}</code>
                    </pre>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="realtime" className="mt-6">
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>WebSocket Connection</CardTitle>
                    <CardDescription>Connect to real-time updates via WebSocket</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                      <code>{`const ws = new WebSocket('ws://localhost:3000/api/realtime');

ws.onopen = () => {
  // Subscribe to table changes
  ws.send(JSON.stringify({
    type: 'subscribe',
    table: 'users'
  }));
  
  // Join a channel
  ws.send(JSON.stringify({
    type: 'join_channel',
    channel: 'chat-room-1'
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === 'table_change') {
    console.log('Table change:', data.operation, data.record);
  } else if (data.type === 'broadcast') {
    console.log('Broadcast:', data.event, data.payload);
  } else if (data.type === 'presence') {
    console.log('Presence update:', data.joins, data.leaves);
  }
};

// Send broadcast message
ws.send(JSON.stringify({
  type: 'broadcast',
  channel: 'chat-room-1',
  event: 'message',
  payload: { text: 'Hello World!' }
}));`}</code>
                    </pre>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Real-time Message Types</CardTitle>
                    <CardDescription>Different types of real-time events</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      <div>
                        <h4 className="font-semibold mb-2">Table Changes</h4>
                        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
                          <code>{`{
  "type": "table_change",
  "table": "users",
  "operation": "INSERT",
  "record": { "id": 1, "email": "user@example.com" }
}`}</code>
                        </pre>
                      </div>
                      <div>
                        <h4 className="font-semibold mb-2">Broadcast Messages</h4>
                        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
                          <code>{`{
  "type": "broadcast",
  "channel": "chat-room-1",
  "event": "message",
  "payload": { "text": "Hello World!" }
}`}</code>
                        </pre>
                      </div>
                      <div>
                        <h4 className="font-semibold mb-2">Presence Updates</h4>
                        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
                          <code>{`{
  "type": "presence",
  "channel": "chat-room-1",
  "joins": [{"user_id": 1}],
  "leaves": [{"user_id": 2}]
}`}</code>
                        </pre>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
          </Tabs>

          <div className="mt-8 pt-8 border-t">
            <div className="flex flex-wrap gap-4 justify-center">
              <Link href="/api-docs">
                <Button variant="outline">
                  View Full API Docs
                </Button>
              </Link>
              <Link href="/dashboard">
                <Button variant="outline">
                  Go to Dashboard
                </Button>
              </Link>
              <a href="https://github.com" target="_blank" rel="noopener noreferrer">
                <Button variant="outline">
                  GitHub Repository
                </Button>
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
