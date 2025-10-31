import { NextResponse } from "next/server"
import { requireAuth, securityHeaders, createInternalError } from "@/lib/api-utils"
import { API_SCOPES } from "@/lib/api-key-utils"

export async function GET() {
  try {
    const auth = await requireAuth()
    if (!auth.success) {
      return auth.error
    }

    const scopes = Object.entries(API_SCOPES).map(([scope, description]) => ({
      scope,
      description,
    }))

    return NextResponse.json({ 
      scopes 
    }, {
      headers: securityHeaders()
    })
  } catch (error) {
    console.error("Error fetching scopes:", error)
    return createInternalError("Failed to fetch scopes")
  }
}