import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

export async function POST(request: Request, { params }: { params: Promise<{ tableName: string }> }) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { tableName } = await params
    const { data } = await request.json()

    const columns = Object.keys(data)
    const values = Object.values(data)
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ")

    const query = `INSERT INTO ${sql(tableName)} (${columns.join(", ")}) VALUES (${placeholders}) RETURNING *`
    const result = await sql(query, values)

    return NextResponse.json({ success: true, row: result[0] })
  } catch (error) {
    console.error("Error adding row:", error)
    return NextResponse.json({ error: "Failed to add row" }, { status: 500 })
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ tableName: string }> }) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { tableName } = await params
    const { id, data } = await request.json()

    const updates = Object.entries(data)
      .filter(([key]) => key !== "id" && key !== "created_at")
      .map(([key], i) => `${key} = $${i + 1}`)
      .join(", ")

    const values = Object.entries(data)
      .filter(([key]) => key !== "id" && key !== "created_at")
      .map(([, value]) => value)

    const query = `UPDATE ${sql(tableName)} SET ${updates} WHERE id = $${values.length + 1} RETURNING *`
    const result = await sql(query, [...values, id])

    return NextResponse.json({ success: true, row: result[0] })
  } catch (error) {
    console.error("Error updating row:", error)
    return NextResponse.json({ error: "Failed to update row" }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ tableName: string }> }) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { tableName } = await params
    const { id } = await request.json()

    await sql(`DELETE FROM ${sql(tableName)} WHERE id = $1`, [id])

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Error deleting row:", error)
    return NextResponse.json({ error: "Failed to delete row" }, { status: 500 })
  }
}
