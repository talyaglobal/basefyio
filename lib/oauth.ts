import { createHash, randomBytes } from "crypto"

export type OAuthProvider = "github" | "google" | "gitlab" | "vercel"

export function base64UrlEncode(buffer: Buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function generateCodeVerifier() {
  return base64UrlEncode(randomBytes(32))
}

export function generateCodeChallenge(verifier: string) {
  return base64UrlEncode(createHash("sha256").update(verifier).digest())
}

export function getProviderConfig(provider: OAuthProvider) {
  switch (provider) {
    case "github":
      return {
        authUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        userUrl: "https://api.github.com/user",
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
        scope: "read:user user:email repo",
      }
    case "google":
      return {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        userUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        scope: "openid email profile",
      }
    case "gitlab":
      return {
        authUrl: process.env.GITLAB_AUTH_URL || "https://gitlab.com/oauth/authorize",
        tokenUrl: process.env.GITLAB_TOKEN_URL || "https://gitlab.com/oauth/token",
        userUrl: process.env.GITLAB_USER_URL || "https://gitlab.com/api/v4/user",
        clientId: process.env.GITLAB_CLIENT_ID!,
        clientSecret: process.env.GITLAB_CLIENT_SECRET!,
        scope: "read_user read_api read_repository write_repository",
      }
    case "vercel":
      return {
        authUrl: "https://vercel.com/integrations/authorize",
        tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
        userUrl: "https://api.vercel.com/v2/user",
        clientId: process.env.VERCEL_CLIENT_ID!,
        clientSecret: process.env.VERCEL_CLIENT_SECRET!,
        scope: "",
      }
  }
}


