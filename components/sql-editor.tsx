"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Play, Save, Trash2, Clock, Download } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useWorkspace } from "@/components/workspace-context"

interface QueryResult {
  columns: string[]
  rows: any[]
  rowCount: number
  executionTime: number
}

interface SavedQuery {
  id: string
  name: string
  query: string
  created_at: string
}

export function SqlEditor() {
  const { selectedDatabase } = useWorkspace()
  const [query, setQuery] = useState("SELECT * FROM users LIMIT 10;")
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([])
  const [queryName, setQueryName] = useState("")
  const [activeTab, setActiveTab] = useState("editor")

  useEffect(() => {
    loadSavedQueries()
  }, [])

  const loadSavedQueries = async () => {
    try {
      const response = await fetch("/api/sql/saved")
      const data = await response.json()
      if (response.ok) {
        setSavedQueries(data.queries)
      }
    } catch (err) {
      console.error("Failed to load saved queries:", err)
    }
  }

  const executeQuery = async () => {
    setLoading(true)
    setError("")
    setResult(null)

    try {
      const startTime = performance.now()
      const response = await fetch("/api/sql/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          query,
          database_id: selectedDatabase?.id 
        }),
      })

      const data = await response.json()
      const executionTime = performance.now() - startTime

      if (!response.ok) {
        throw new Error(data.error)
      }

      setResult({
        columns: data.columns || [],
        rows: data.rows || [],
        rowCount: data.rows?.length || 0,
        executionTime,
      })
      setActiveTab("results")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to execute query")
    } finally {
      setLoading(false)
    }
  }

  const saveQuery = async () => {
    if (!queryName.trim()) {
      setError("Please enter a name for the query")
      return
    }

    try {
      const response = await fetch("/api/sql/saved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: queryName, query }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error)
      }

      await loadSavedQueries()
      setQueryName("")
      setError("")
      alert("Query saved successfully!")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save query")
    }
  }

  const loadQuery = (savedQuery: SavedQuery) => {
    setQuery(savedQuery.query)
    setActiveTab("editor")
  }

  const deleteQuery = async (id: string) => {
    if (!confirm("Are you sure you want to delete this query?")) return

    try {
      const response = await fetch(`/api/sql/saved/${id}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        throw new Error("Failed to delete query")
      }

      await loadSavedQueries()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete query")
    }
  }

  const exportResults = () => {
    if (!result) return

    const csv = [
      result.columns.join(","),
      ...result.rows.map((row) => result.columns.map((col) => JSON.stringify(row[col] ?? "")).join(",")),
    ].join("\n")

    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `query-results-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const exampleQueries = [
    { name: "Select all users", query: "SELECT * FROM users LIMIT 10;" },
    { name: "Count records", query: "SELECT COUNT(*) as total FROM users;" },
    { name: "Recent records", query: "SELECT * FROM users ORDER BY created_at DESC LIMIT 5;" },
    { name: "Create table", query: "CREATE TABLE example (\n  id SERIAL PRIMARY KEY,\n  name TEXT NOT NULL\n);" },
  ]

  return (
    <div className="space-y-4">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="editor">Editor</TabsTrigger>
          <TabsTrigger value="results">Results</TabsTrigger>
          <TabsTrigger value="saved">Saved Queries</TabsTrigger>
        </TabsList>

        <TabsContent value="editor" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Query Editor</CardTitle>
                  <CardDescription>Write your SQL query below</CardDescription>
                </div>
                <div className="flex gap-2">
                  <Select onValueChange={(value) => setQuery(exampleQueries[Number.parseInt(value)].query)}>
                    <SelectTrigger className="w-[200px]">
                      <SelectValue placeholder="Load example" />
                    </SelectTrigger>
                    <SelectContent>
                      {exampleQueries.map((ex, i) => (
                        <SelectItem key={i} value={i.toString()}>
                          {ex.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Enter your SQL query..."
                className="font-mono min-h-[200px] text-sm"
              />
              <div className="flex gap-2">
                <Button onClick={executeQuery} disabled={loading || !query.trim()}>
                  <Play className="h-4 w-4 mr-2" />
                  {loading ? "Executing..." : "Execute Query"}
                </Button>
                <div className="flex gap-2 flex-1">
                  <input
                    type="text"
                    placeholder="Query name..."
                    value={queryName}
                    onChange={(e) => setQueryName(e.target.value)}
                    className="flex-1 px-3 py-2 text-sm border rounded-md"
                  />
                  <Button variant="outline" onClick={saveQuery} disabled={!query.trim() || !queryName.trim()}>
                    <Save className="h-4 w-4 mr-2" />
                    Save
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </TabsContent>

        <TabsContent value="results">
          {result ? (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Query Results</CardTitle>
                    <CardDescription>
                      {result.rowCount} {result.rowCount === 1 ? "row" : "rows"} • Executed in{" "}
                      {result.executionTime.toFixed(2)}ms
                    </CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={exportResults}>
                    <Download className="h-4 w-4 mr-2" />
                    Export CSV
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {result.columns.map((col) => (
                          <TableHead key={col} className="whitespace-nowrap">
                            {col}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.rows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={result.columns.length} className="text-center text-muted-foreground">
                            No results
                          </TableCell>
                        </TableRow>
                      ) : (
                        result.rows.map((row, i) => (
                          <TableRow key={i}>
                            {result.columns.map((col) => (
                              <TableCell key={col} className="whitespace-nowrap">
                                <span className="text-sm">
                                  {row[col] !== null && row[col] !== undefined ? String(row[col]) : "NULL"}
                                </span>
                              </TableCell>
                            ))}
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <Play className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>Execute a query to see results here</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="saved">
          <Card>
            <CardHeader>
              <CardTitle>Saved Queries</CardTitle>
              <CardDescription>Your saved SQL queries</CardDescription>
            </CardHeader>
            <CardContent>
              {savedQueries.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground">
                  <Save className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No saved queries yet</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {savedQueries.map((sq) => (
                    <div key={sq.id} className="flex items-center justify-between p-4 border rounded-lg">
                      <div className="flex-1">
                        <h4 className="font-medium">{sq.name}</h4>
                        <p className="text-sm text-muted-foreground font-mono mt-1 truncate">{sq.query}</p>
                        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {new Date(sq.created_at).toLocaleString()}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => loadQuery(sq)}>
                          Load
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => deleteQuery(sq.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
