"use client"

import { AlertDescription } from "@/components/ui/alert"

import { Alert } from "@/components/ui/alert"

import { DialogDescription } from "@/components/ui/dialog"

import { DialogTitle } from "@/components/ui/dialog"

import { DialogHeader } from "@/components/ui/dialog"

import { DialogContent } from "@/components/ui/dialog"

import { DialogTrigger } from "@/components/ui/dialog"

import { Dialog } from "@/components/ui/dialog"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, RefreshCw, Search, Edit, Trash2, Save, X, Shield } from "lucide-react"

interface TableInfo {
  table_name: string
  row_count: number
}

interface ColumnInfo {
  column_name: string
  data_type: string
  is_nullable: string
}

export function TableBrowser() {
  const [tables, setTables] = useState<TableInfo[]>([])
  const [selectedTable, setSelectedTable] = useState<string>("")
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [searchTerm, setSearchTerm] = useState("")
  const [editingRow, setEditingRow] = useState<number | null>(null)
  const [editedData, setEditedData] = useState<any>({})
  const [isAddingRow, setIsAddingRow] = useState(false)
  const [newRowData, setNewRowData] = useState<any>({})
  const [bypassRLS, setBypassRLS] = useState(false)

  useEffect(() => {
    loadTables()
  }, [])

  useEffect(() => {
    if (selectedTable) {
      loadTableData(selectedTable)
    }
  }, [selectedTable])

  const loadTables = async () => {
    setLoading(true)
    setError("")
    try {
      const response = await fetch("/api/tables")
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      setTables(data.tables)
      if (data.tables.length > 0 && !selectedTable) {
        setSelectedTable(data.tables[0].table_name)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tables")
    } finally {
      setLoading(false)
    }
  }

  const loadTableData = async (tableName: string) => {
    setLoading(true)
    setError("")
    try {
      const url = `/api/tables/${tableName}${bypassRLS ? "?bypassRLS=true" : ""}`
      const response = await fetch(url)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      setColumns(data.columns)
      setRows(data.rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load table data")
    } finally {
      setLoading(false)
    }
  }

  const handleEdit = (index: number) => {
    setEditingRow(index)
    setEditedData({ ...rows[index] })
  }

  const handleSave = async (index: number) => {
    setLoading(true)
    setError("")
    try {
      const response = await fetch(`/api/tables/${selectedTable}/rows`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rows[index].id, data: editedData }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      await loadTableData(selectedTable)
      setEditingRow(null)
      setEditedData({})
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update row")
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this row?")) return
    setLoading(true)
    setError("")
    try {
      const response = await fetch(`/api/tables/${selectedTable}/rows`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      await loadTableData(selectedTable)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete row")
    } finally {
      setLoading(false)
    }
  }

  const handleAddRow = async () => {
    setLoading(true)
    setError("")
    try {
      const response = await fetch(`/api/tables/${selectedTable}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: newRowData }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      await loadTableData(selectedTable)
      setIsAddingRow(false)
      setNewRowData({})
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add row")
    } finally {
      setLoading(false)
    }
  }

  const filteredRows = rows.filter((row) =>
    Object.values(row).some((value) => String(value).toLowerCase().includes(searchTerm.toLowerCase())),
  )

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Tables</CardTitle>
              <CardDescription>Select a table to view and edit its data</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  setBypassRLS(!bypassRLS)
                  if (selectedTable) loadTableData(selectedTable)
                }}
                variant={bypassRLS ? "default" : "outline"}
                size="sm"
                className={bypassRLS ? "bg-green-600 hover:bg-green-700" : ""}
              >
                <Shield className="h-4 w-4 mr-2" />
                {bypassRLS ? "RLS Bypassed" : "Bypass RLS"}
              </Button>
              <Button onClick={loadTables} variant="outline" size="sm" disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <Label>Select Table</Label>
              <Select value={selectedTable} onValueChange={setSelectedTable}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a table" />
                </SelectTrigger>
                <SelectContent>
                  {tables.map((table) => (
                    <SelectItem key={table.table_name} value={table.table_name}>
                      {table.table_name} ({table.row_count} rows)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <Label>Search</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search in table..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8"
                />
              </div>
            </div>
            <Dialog open={isAddingRow} onOpenChange={setIsAddingRow}>
              <DialogTrigger asChild>
                <Button disabled={!selectedTable}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Row
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add New Row</DialogTitle>
                  <DialogDescription>Enter values for the new row</DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  {columns
                    .filter((col) => col.column_name !== "id" && col.column_name !== "created_at")
                    .map((col) => (
                      <div key={col.column_name} className="space-y-2">
                        <Label>{col.column_name}</Label>
                        <Input
                          value={newRowData[col.column_name] || ""}
                          onChange={(e) => setNewRowData({ ...newRowData, [col.column_name]: e.target.value })}
                        />
                      </div>
                    ))}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setIsAddingRow(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleAddRow} disabled={loading}>
                    {loading ? "Adding..." : "Add Row"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent>
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      )}

      {selectedTable && (
        <Card>
          <CardHeader>
            <CardTitle>{selectedTable}</CardTitle>
            <CardDescription>
              {filteredRows.length} {filteredRows.length === 1 ? "row" : "rows"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {columns.map((col) => (
                      <TableHead key={col.column_name} className="whitespace-nowrap">
                        {col.column_name}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={columns.length + 1} className="text-center text-muted-foreground">
                        No data found
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredRows.map((row, index) => (
                      <TableRow key={row.id || index}>
                        {columns.map((col) => (
                          <TableCell key={col.column_name} className="whitespace-nowrap">
                            {editingRow === index && col.column_name !== "id" && col.column_name !== "created_at" ? (
                              <Input
                                value={editedData[col.column_name] || ""}
                                onChange={(e) => setEditedData({ ...editedData, [col.column_name]: e.target.value })}
                                className="h-8"
                              />
                            ) : (
                              <span className="text-sm">
                                {row[col.column_name] !== null ? String(row[col.column_name]) : "NULL"}
                              </span>
                            )}
                          </TableCell>
                        ))}
                        <TableCell className="text-right">
                          {editingRow === index ? (
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="ghost" onClick={() => handleSave(index)} disabled={loading}>
                                <Save className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setEditingRow(null)
                                  setEditedData({})
                                }}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ) : (
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="ghost" onClick={() => handleEdit(index)}>
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => handleDelete(row.id)} disabled={loading}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
