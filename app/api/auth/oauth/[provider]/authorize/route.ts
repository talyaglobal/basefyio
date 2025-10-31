import { NextRequest, NextResponse } from "next/server"
import { generateCodeChallenge, generateCodeVerifier, getProviderConfig, type OAuthProvider } from "@/lib/oauth"

export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  
  // Validate provider type
  if (provider !== "github" && provider !== "google") {
    return NextResponse.json({ error: "Invalid OAuth provider" }, { status: 400 })
  }
  
  const cfg = getProviderConfig(provider as OAuthProvider)

  const url = new URL(request.url)
  const redirectUri = `${url.origin}/api/auth/oauth/${provider}/callback`
  const state = Math.random().toString(36).slice(2)
  const nonce = Math.random().toString(36).slice(2)
  const verifier = generateCodeVerifier()
  const challenge = generateCodeChallenge(verifier)

  const authUrl = new URL(cfg.authUrl)
  authUrl.searchParams.set("client_id", cfg.clientId)
  authUrl.searchParams.set("redirect_uri", redirectUri)
  authUrl.searchParams.set("response_type", "code")
  authUrl.searchParams.set("scope", cfg.scope)
  authUrl.searchParams.set("state", state)
  // PKCE
  authUrl.searchParams.set("code_challenge", challenge)
  authUrl.searchParams.set("code_challenge_method", "S256")
  // OpenID specific (Google)
  if (provider === "google") authUrl.searchParams.set("nonce", nonce)

  const response = NextResponse.redirect(authUrl.toString())
  // Store verifier/state/nonce in cookies for callback validation
  response.cookies.set(`kb_oauth_${provider}_state`, state, { httpOnly: true, path: "/", maxAge: 600 })
  response.cookies.set(`kb_oauth_${provider}_nonce`, nonce, { httpOnly: true, path: "/", maxAge: 600 })
  response.cookies.set(`kb_oauth_${provider}_verifier`, verifier, { httpOnly: true, path: "/", maxAge: 600 })
  return response
}


