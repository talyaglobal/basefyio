import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"
import { getProviderConfig, type OAuthProvider } from "@/lib/oauth"

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
      return NextResponse.redirect(new URL("/sign-in", request.url))
    }

    const { provider } = await params

    if (!INTEGRATION_PROVIDERS.includes(provider as IntegrationProvider)) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 })
    }

    const url = new URL(request.url)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    const error = url.searchParams.get("error")

    if (error) {
      return NextResponse.redirect(
        new URL(`/dashboard/integrations?error=${encodeURIComponent(error)}`, request.url)
      )
    }

    if (!code || !state) {
      return NextResponse.redirect(
        new URL("/dashboard/integrations?error=missing_code_or_state", request.url)
      )
    }

    // Verify state
    const stateCookie = request.cookies.get(`kb_integration_${provider}_state`)?.value
    const verifier = request.cookies.get(`kb_integration_${provider}_verifier`)?.value
    const teamId = request.cookies.get(`kb_integration_${provider}_team_id`)?.value || null
    const projectId = request.cookies.get(`kb_integration_${provider}_project_id`)?.value || null

    if (!stateCookie || stateCookie !== state || !verifier) {
      return NextResponse.redirect(
        new URL("/dashboard/integrations?error=invalid_state", request.url)
      )
    }

    const cfg = getProviderConfig(provider as OAuthProvider)
    const redirectUri = `${url.origin}/api/integrations/${provider}/callback`

    // Exchange code for tokens
    const tokenRes = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code_verifier: verifier,
      }),
    })

    if (!tokenRes.ok) {
      const errorText = await tokenRes.text()
      console.error("Token exchange failed:", errorText)
      return NextResponse.redirect(
        new URL("/dashboard/integrations?error=token_exchange_failed", request.url)
      )
    }

    const tokenData = await tokenRes.json()
    const accessToken = tokenData.access_token
    const refreshToken = tokenData.refresh_token

    if (!accessToken) {
      return NextResponse.redirect(
        new URL("/dashboard/integrations?error=no_access_token", request.url)
      )
    }

    // Fetch user info from provider
    const userRes = await fetch(cfg.userUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(provider === "gitlab" ? {} : {}),
      },
    })

    if (!userRes.ok) {
      return NextResponse.redirect(
        new URL("/dashboard/integrations?error=user_fetch_failed", request.url)
      )
    }

    const providerUser = await userRes.json()

    // Extract user info based on provider
    let providerUserId: string
    let providerUsername: string
    let providerEmail: string
    let providerAvatarUrl: string | null = null

    if (provider === "github") {
      providerUserId = String(providerUser.id)
      providerUsername = providerUser.login
      providerEmail = providerUser.email || ""
      providerAvatarUrl = providerUser.avatar_url || null

      // If email is private, fetch it separately
      if (!providerEmail) {
        const emailsRes = await fetch("https://api.github.com/user/emails", {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (emailsRes.ok) {
          const emails = await emailsRes.json()
          const primary = Array.isArray(emails)
            ? emails.find((e: any) => e.primary && e.verified)
            : null
          providerEmail = primary?.email || `gh_${providerUserId}@users.noreply.github.com`
        }
      }
    } else if (provider === "gitlab") {
      providerUserId = String(providerUser.id)
      providerUsername = providerUser.username
      providerEmail = providerUser.email || ""
      providerAvatarUrl = providerUser.avatar_url || null
    } else if (provider === "vercel") {
      providerUserId = providerUser.user?.id || String(providerUser.id)
      providerUsername = providerUser.user?.username || providerUser.username || ""
      providerEmail = providerUser.user?.email || providerUser.email || ""
      providerAvatarUrl = providerUser.user?.avatar || null
    } else {
      providerUserId = String(providerUser.id || "")
      providerUsername = providerUser.username || providerUser.login || ""
      providerEmail = providerUser.email || ""
      providerAvatarUrl = providerUser.avatar_url || providerUser.avatar || null
    }

    // TODO: Encrypt tokens before storing (use a proper encryption library)
    const accessTokenEncrypted = accessToken // Placeholder - should be encrypted
    const refreshTokenEncrypted = refreshToken || null // Placeholder - should be encrypted

    // Calculate token expiry (default to 1 hour if not provided)
    const expiresIn = tokenData.expires_in || 3600
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000)

    // Upsert integration
    const existing = await sql`
      SELECT id FROM integrations
      WHERE user_id = ${user.id}
        AND provider = ${provider}
        AND (team_id = ${teamId} OR (team_id IS NULL AND ${teamId} IS NULL))
        AND (project_id = ${projectId} OR (project_id IS NULL AND ${projectId} IS NULL))
      LIMIT 1
    `

    if (existing.length > 0) {
      // Update existing
      await sql`
        UPDATE integrations
        SET 
          access_token_encrypted = ${accessTokenEncrypted},
          refresh_token_encrypted = ${refreshTokenEncrypted},
          token_expires_at = ${tokenExpiresAt.toISOString()},
          provider_user_id = ${providerUserId},
          provider_username = ${providerUsername},
          provider_email = ${providerEmail},
          provider_avatar_url = ${providerAvatarUrl},
          status = 'connected',
          connected_at = COALESCE(connected_at, NOW()),
          disconnected_at = NULL,
          sync_status = 'idle',
          updated_at = NOW()
        WHERE id = ${existing[0].id}
      `
    } else {
      // Create new
      await sql`
        INSERT INTO integrations (
          user_id,
          team_id,
          project_id,
          provider,
          status,
          access_token_encrypted,
          refresh_token_encrypted,
          token_expires_at,
          provider_user_id,
          provider_username,
          provider_email,
          provider_avatar_url,
          config,
          sync_status
        ) VALUES (
          ${user.id},
          ${teamId},
          ${projectId},
          ${provider},
          'connected',
          ${accessTokenEncrypted},
          ${refreshTokenEncrypted},
          ${tokenExpiresAt.toISOString()},
          ${providerUserId},
          ${providerUsername},
          ${providerEmail},
          ${providerAvatarUrl},
          '{}'::jsonb,
          'idle'
        )
      `
    }

    // Clear cookies
    const response = NextResponse.redirect(new URL("/dashboard/integrations?connected=true", request.url))
    response.cookies.delete(`kb_integration_${provider}_state`)
    response.cookies.delete(`kb_integration_${provider}_verifier`)
    if (teamId) response.cookies.delete(`kb_integration_${provider}_team_id`)
    if (projectId) response.cookies.delete(`kb_integration_${provider}_project_id`)

    return response
  } catch (error) {
    console.error("Error in OAuth callback:", error)
    return NextResponse.redirect(
      new URL("/dashboard/integrations?error=callback_failed", request.url)
    )
  }
}

