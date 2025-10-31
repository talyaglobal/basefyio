import { NextResponse } from "next/server"

const PROVIDERS: Record<string, { authUrl: string; clientIdEnv: string; scope?: string[] }> = {
  github: {
    authUrl: "https://github.com/login/oauth/authorize",
    clientIdEnv: "GITHUB_CLIENT_ID",
    scope: ["read:user", "user:email"],
  },
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    scope: ["openid", "email", "profile"],
  },
}

export async function GET(_: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  const cfg = PROVIDERS[provider]
  if (!cfg) {
    return NextResponse.json({ code: "UNSUPPORTED_PROVIDER", message: "Unsupported provider" }, { status: 400 })
  }

  const clientId = process.env[cfg.clientIdEnv]
  const redirectUri = `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/auth/oauth/${provider}/callback`

  const state = Math.random().toString(36).slice(2)
  const searchParams = new URLSearchParams({
    client_id: clientId || "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: (cfg.scope || []).join(" "),
    state,
  })

  const url = `${cfg.authUrl}?${searchParams.toString()}`
  return NextResponse.redirect(url)
}


