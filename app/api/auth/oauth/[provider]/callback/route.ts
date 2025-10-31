import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { SignJWT } from "jose"
import { getProviderConfig, type OAuthProvider } from "@/lib/oauth"

const sql = neon(process.env.DATABASE_URL!)

export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  try {
    const { provider } = await params
    
    // Validate provider type
    if (provider !== "github" && provider !== "google") {
      return NextResponse.json({ error: "Invalid OAuth provider" }, { status: 400 })
    }
    
    const cfg = getProviderConfig(provider as OAuthProvider)

    const url = new URL(request.url)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    if (!code || !state) return NextResponse.json({ error: "Invalid callback" }, { status: 400 })

    const stateCookie = request.cookies.get(`kb_oauth_${provider}_state`)?.value
    const verifier = request.cookies.get(`kb_oauth_${provider}_verifier`)?.value
    if (!stateCookie || stateCookie !== state || !verifier) return NextResponse.json({ error: "Invalid state" }, { status: 400 })

    const redirectUri = `${url.origin}/api/auth/oauth/${provider}/callback`

    // Exchange authorization code for tokens
    const tokenRes = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code_verifier: verifier,
      }),
    })
    const tokenJson = await tokenRes.json()
    const accessToken = tokenJson.access_token as string
    if (!accessToken) return NextResponse.json({ error: "Token exchange failed" }, { status: 400 })

    // Fetch user info
    const userRes = await fetch(cfg.userUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
    const userInfo = await userRes.json()

    // Map provider user to local user
    let email = userInfo.email || userInfo.primary_email || userInfo.login || ""
    if (!email && provider === "github") {
      // Fetch emails for GitHub users with private emails
      const emailsRes = await fetch("https://api.github.com/user/emails", { 
        headers: { Authorization: `Bearer ${accessToken}` } 
      })
      if (emailsRes.ok) {
        const emails = await emailsRes.json()
        const primary = Array.isArray(emails) ? emails.find((e: any) => e.primary && e.verified) : null
        email = primary?.email || `gh_${userInfo.id}@users.noreply.github.com`
      } else {
        email = `gh_${userInfo.id}@users.noreply.github.com`
      }
    }
    if (!email) return NextResponse.json({ error: "No email from provider" }, { status: 400 })

    // Upsert user
    const users = await sql`SELECT id, email FROM users WHERE email = ${email} LIMIT 1`
    let userId = users[0]?.id
    if (!userId) {
      const inserted = await sql`INSERT INTO users (email, created_at) VALUES (${email}, NOW()) RETURNING id`
      userId = inserted[0].id
    }

    // Issue session cookies
    const accessSecret = new TextEncoder().encode(process.env.JWT_SECRET || "your-secret-key")
    const refreshSecret = new TextEncoder().encode(process.env.REFRESH_SECRET || process.env.JWT_SECRET || "your-secret-key")
    
    const rid = crypto.randomUUID()
    const accessJwt = await new SignJWT({ userId, email }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("15m").sign(accessSecret)
    const refreshJwt = await new SignJWT({ userId, email, rid }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("30d").sign(refreshSecret)

    // Store refresh token
    try {
      await sql`
        INSERT INTO refresh_tokens (rid, user_id, email, issued_at, expires_at, revoked)
        VALUES (${rid}, ${userId}, ${email}, NOW(), NOW() + INTERVAL '30 days', false)
        ON CONFLICT (rid) DO UPDATE SET 
          user_id = ${userId},
          email = ${email},
          issued_at = NOW(),
          expires_at = NOW() + INTERVAL '30 days',
          revoked = false
      `
    } catch (e) {
      console.error("Failed to store refresh token:", e)
    }

    const response = NextResponse.redirect(`${url.origin}/dashboard`)
    response.cookies.set("kb_token", accessJwt, { 
      httpOnly: true, 
      path: "/", 
      maxAge: 60 * 15, 
      sameSite: "lax", 
      secure: process.env.NODE_ENV === "production" 
    })
    response.cookies.set("kb_refresh", refreshJwt, { 
      httpOnly: true, 
      path: "/", 
      maxAge: 60 * 60 * 24 * 30, 
      sameSite: "lax", 
      secure: process.env.NODE_ENV === "production" 
    })
    return response
  } catch (e) {
    console.error("OAuth callback error:", e)
    return NextResponse.json({ error: "OAuth callback failed" }, { status: 500 })
  }
}


