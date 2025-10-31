import { NextResponse } from "next/server"
import { getUser } from "@/lib/auth"
import { securityHeaders } from "@/lib/api-utils"

export async function GET() {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    return NextResponse.json({ user }, {
      headers: securityHeaders(),
    })
  } catch (error) {
    console.error("Error fetching auth user:", error)
    return NextResponse.json({ error: "Failed to get user" }, { status: 500 })
  }
}
