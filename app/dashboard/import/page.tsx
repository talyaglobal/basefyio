"use client"

import type React from "react"

import { useState } from "react"
import { DatabaseRequired } from "@/components/database-required"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Upload, FileJson, FileSpreadsheet, CheckCircle2, AlertCircle } from "lucide-react"
import { Progress } from "@/components/ui/progress"

export default function ImportPage() {
  const [selectedTable, setSelectedTable] = useState("users")
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)

  const tables = ["users", "posts", "comments", "profiles"]

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0])
      setResult(null)
    }
  }

  const handleImport = async () => {
    if (!file) return

    setImporting(true)
    setProgress(0)
    setResult(null)

    // Simulate import progress
    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval)
          return 100
        }
        return prev + 10
      })
    }, 200)

    // Simulate import completion
    setTimeout(() => {
      setImporting(false)
      setResult({
        success: true,
        message: `Successfully imported 150 rows into ${selectedTable} table`,
      })
    }, 2500)
  }

  return (
    <DatabaseRequired message="Select or create a database to import data.">
      <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Data Import</h1>
        <p className="text-muted-foreground mt-1">Import data from CSV or JSON files into your tables</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Import Configuration</CardTitle>
            <CardDescription>Select table and upload your data file</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label>Target Table</Label>
              <Select value={selectedTable} onValueChange={setSelectedTable}>
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

            <div className="space-y-2">
              <Label>Data File</Label>
              <div className="border-2 border-dashed rounded-lg p-8 text-center hover:border-primary/50 transition-colors">
                <input
                  type="file"
                  accept=".csv,.json"
                  onChange={handleFileChange}
                  className="hidden"
                  id="file-upload"
                />
                <label htmlFor="file-upload" className="cursor-pointer">
                  <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                  <p className="text-sm font-medium">{file ? file.name : "Click to upload or drag and drop"}</p>
                  <p className="text-xs text-muted-foreground mt-2">CSV or JSON files (max 10MB)</p>
                </label>
              </div>
            </div>

            {importing && (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Importing...</span>
                  <span>{progress}%</span>
                </div>
                <Progress value={progress} />
              </div>
            )}

            {result && (
              <div
                className={`flex items-start gap-3 p-4 rounded-lg ${
                  result.success ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"
                }`}
              >
                {result.success ? (
                  <CheckCircle2 className="h-5 w-5 mt-0.5" />
                ) : (
                  <AlertCircle className="h-5 w-5 mt-0.5" />
                )}
                <p className="text-sm">{result.message}</p>
              </div>
            )}

            <Button
              onClick={handleImport}
              disabled={!file || importing}
              className="w-full bg-green-600 hover:bg-green-700"
            >
              <Upload className="h-4 w-4 mr-2" />
              {importing ? "Importing..." : "Import Data"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>File Format Guide</CardTitle>
            <CardDescription>Ensure your data matches these formats</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="h-5 w-5 text-green-600" />
                <h3 className="font-semibold">CSV Format</h3>
              </div>
              <pre className="bg-muted p-3 rounded text-xs overflow-auto">
                {`id,name,email,created_at
1,John Doe,john@example.com,2024-01-01
2,Jane Smith,jane@example.com,2024-01-02`}
              </pre>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <FileJson className="h-5 w-5 text-blue-600" />
                <h3 className="font-semibold">JSON Format</h3>
              </div>
              <pre className="bg-muted p-3 rounded text-xs overflow-auto">
                {`[
  {
    "id": 1,
    "name": "John Doe",
    "email": "john@example.com",
    "created_at": "2024-01-01"
  },
  {
    "id": 2,
    "name": "Jane Smith",
    "email": "jane@example.com",
    "created_at": "2024-01-02"
  }
]`}
              </pre>
            </div>

            <div className="space-y-2 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Important Notes:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Column names must match table schema</li>
                <li>Date formats should be ISO 8601</li>
                <li>Missing columns will use default values</li>
                <li>Duplicate IDs will be skipped</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
      </div>
    </DatabaseRequired>
  )
}
