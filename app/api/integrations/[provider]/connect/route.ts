import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"
import { generateCodeChallenge, generateCodeVerifier, getProviderConfig, type OAuthProvider } from "@/lib/oauth"

const sql = neon(process.env.DATABASE_URL!)

const INTEGRATION_PROVIDERS = ["github", "gitlab", "vercel"] as const
type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number]

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { provider } = await params

    if (!INTEGRATION_PROVIDERS.includes(provider as IntegrationProvider)) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 })
    }

    // Get team and project from query params if provided
    const url = new URL(request.url)
    const teamId = url.searchParams.get("team_id")
    const projectId = url.searchParams.get("project_id")

    // Get provider config
    const cfg = getProviderConfig(provider as OAuthProvider)
    if (!cfg.clientId || !cfg.clientSecret) {
      return NextResponse.json(
        { error: `${provider} OAuth is not configured. Please set ${provider.toUpperCase()}_CLIENT_ID and ${provider.toUpperCase()}_CLIENT_SECRET` },
        { status: 500 }
      )
    }

    const redirectUri = `${url.origin}/api/integrations/${provider}/callback`
    const state = Math.random().toString(36).slice(2)
    const verifier = generateCodeVerifier()
    const challenge = generateCodeChallenge(verifier)

    // Build OAuth URL
    const authUrl = new URL(cfg.authUrl)
    authUrl.searchParams.set("client_id", cfg.clientId)
    authUrl.searchParams.set("redirect_uri", redirectUri)
    authUrl.searchParams.set("response_type", "code")
    authUrl.searchParams.set("scope", cfg.scope || "")
    authUrl.searchParams.set("state", state)
    authUrl.searchParams.set("code_challenge", challenge)
    authUrl.searchParams.set("code_challenge_method", "S256")

    // Store state and verifier in cookie with user context
    const response = NextResponse.redirect(authUrl.toString())
    response.cookies.set(`kb_integration_${provider}_state`, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600, // 10 minutes
    })
    response.cookies.set(`kb_integration_${provider}_verifier`, verifier, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
    })
    if (teamId) {
      response.cookies.set(`kb_integration_${provider}_team_id`, teamId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 600,
      })
    }
    if (projectId) {
      response.cookies.set(`kb_integration_${provider}_project_id`, projectId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 600,
      })
    }

    return response
  } catch (error) {
    console.error("Error initiating OAuth:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

