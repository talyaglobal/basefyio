import { createHash, randomBytes } from "crypto"

export type OAuthProvider = "github" | "google"

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
        scope: "read:user user:email",
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
  }
}


