import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

// Simple GraphQL resolver
async function resolveGraphQL(query: string, variables: any) {
  // Parse the query to determine the operation
  const isQuery = query.includes("query")
  const isMutation = query.includes("mutation")

  if (query.includes("users") && isQuery) {
    // Get all users
    const users = await sql`SELECT id, email, created_at FROM users ORDER BY created_at DESC LIMIT 50`
    return { users }
  }

  if (query.includes("user(") && isQuery) {
    // Get single user
    const userId = variables.id
    const users = await sql`SELECT id, email, created_at FROM users WHERE id = ${userId} LIMIT 1`
    return { user: users[0] || null }
  }

  if (query.includes("createUser") && isMutation) {
    // Create user (simplified - in production use proper password hashing)
    const { email, password } = variables
    const users = await sql`
      INSERT INTO users (email, password_hash)
      VALUES (${email}, ${password})
      RETURNING id, email, created_at
    `
    return { createUser: users[0] }
  }

  if (query.includes("updateUser") && isMutation) {
    // Update user
    const { id, email } = variables
    const users = await sql`
      UPDATE users
      SET email = ${email}
      WHERE id = ${id}
      RETURNING id, email, created_at
    `
    return { updateUser: users[0] || null }
  }

  if (query.includes("deleteUser") && isMutation) {
    // Delete user
    const { id } = variables
    await sql`DELETE FROM users WHERE id = ${id}`
    return { deleteUser: true }
  }

  throw new Error("Unknown GraphQL operation")
}

export async function POST(request: Request) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { query, variables } = await request.json()

    if (!query) {
      return NextResponse.json({ error: "Query is required" }, { status: 400 })
    }

    const data = await resolveGraphQL(query, variables || {})

    return NextResponse.json({ data })
  } catch (error: any) {
    console.error("GraphQL error:", error)
    return NextResponse.json(
      {
        errors: [{ message: error.message || "GraphQL execution failed" }],
      },
      { status: 400 },
    )
  }
}
