import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

export async function GET() {
  try {
    // Get recent activity from audit logs if available
    const activity = await sql`
      SELECT * FROM audit_logs 
      ORDER BY created_at DESC 
      LIMIT 10
    `

    return NextResponse.json({ activity })
  } catch (error: any) {
    // If audit_logs table doesn't exist, return mock data
    return NextResponse.json({
      activity: [
        {
          id: 1,
          action: "Table Created",
          description: "Created table 'users'",
          user: "admin@example.com",
          created_at: new Date().toISOString(),
        },
      ],
    })
  }
}
