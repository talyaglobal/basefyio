import { NextResponse } from "next/server"
import { requireScopesWithRateLimit, securityHeaders } from "@/lib/api-utils"

// Minimal, curated template set. Extend as needed.
const POLICY_TEMPLATES = [
  {
    id: "owner_read",
    name: "Owner can read their rows",
    description: "Allow SELECT where row.user_id = auth.uid()",
    type: "SELECT",
    expression: "user_id = auth.uid()",
    roles: ["authenticated"],
  },
  {
    id: "owner_crud",
    name: "Owner can read/write their rows",
    description: "Allow ALL where row.user_id = auth.uid()",
    type: "ALL",
    expression: "user_id = auth.uid()",
    roles: ["authenticated"],
  },
  {
    id: "public_read",
    name: "Public read",
    description: "Allow SELECT for everyone",
    type: "SELECT",
    expression: "true",
    roles: ["public"],
  },
]

export async function GET(request: Request) {
  const auth = await requireScopesWithRateLimit(request, ["read:rls"]) 
  if (!auth.success) return auth.error

  return NextResponse.json(
    { templates: POLICY_TEMPLATES },
    { headers: { ...securityHeaders(), ...auth.rateLimitHeaders } }
  )
}


