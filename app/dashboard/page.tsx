import { getUser } from "@/lib/auth"
import DashboardHeader from "@/components/DashboardHeader" // Import the shared DashboardHeader component
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Database, Table2, Code2, Activity } from "lucide-react"

export default async function DashboardPage() {
  const user = await getUser()

  return (
    <div className="space-y-6">
      <DashboardHeader user={user} /> {/* Use the shared DashboardHeader component */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Databases</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">1</div>
            <p className="text-xs text-muted-foreground">Connected database</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Tables</CardTitle>
            <Table2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">-</div>
            <p className="text-xs text-muted-foreground">Database tables</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Queries</CardTitle>
            <Code2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">0</div>
            <p className="text-xs text-muted-foreground">Saved queries</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">API Keys</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">0</div>
            <p className="text-xs text-muted-foreground">Active keys</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Quick Start</CardTitle>
          <CardDescription>Get started with Kolaybase by exploring these features</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-4 rounded-lg border p-4">
            <Table2 className="h-5 w-5 text-primary mt-0.5" />
            <div>
              <h3 className="font-medium">Table Editor</h3>
              <p className="text-sm text-muted-foreground">
                Browse and edit your database tables with an intuitive interface
              </p>
            </div>
          </div>
          <div className="flex items-start gap-4 rounded-lg border p-4">
            <Code2 className="h-5 w-5 text-primary mt-0.5" />
            <div>
              <h3 className="font-medium">SQL Editor</h3>
              <p className="text-sm text-muted-foreground">
                Write and execute SQL queries with syntax highlighting and autocomplete
              </p>
            </div>
          </div>
          <div className="flex items-start gap-4 rounded-lg border p-4">
            <Activity className="h-5 w-5 text-primary mt-0.5" />
            <div>
              <h3 className="font-medium">GraphQL Explorer</h3>
              <p className="text-sm text-muted-foreground">Test GraphQL queries and explore your API schema</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
