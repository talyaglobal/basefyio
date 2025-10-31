import { cookies, headers } from "next/headers"
import { jwtVerify } from "jose"
import { neon } from "@neondatabase/serverless"
import { hashApiKey, type ApiScope } from "./api-key-utils"

const sql = neon(process.env.DATABASE_URL!)

export interface User {
  id: string
  email: string
  authMethod: "session" | "api_key"
  apiKeyScopes?: ApiScope[]
}

export async function getUser(): Promise<User | null> {
  try {
    // Try API key authentication first
    const headersList = await headers()
    const apiKey = headersList.get("x-api-key") || headersList.get("authorization")?.replace("Bearer ", "")
    
    if (apiKey) {
      const hashedKey = await hashApiKey(apiKey)
      
      const apiKeys = await sql`
        SELECT ak.id, ak.name, ak.scopes, ak.user_id, ak.expires_at, ak.is_active, u.email
        FROM api_keys ak
        JOIN users u ON u.id = ak.user_id
        WHERE ak.hashed_key = ${hashedKey} AND ak.is_active = true
        LIMIT 1
      `
      
      if (apiKeys.length > 0) {
        const keyData = apiKeys[0]
        
        // Check if key is expired
        if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
          return null
        }
        
        // Update last used timestamp
        await sql`
          UPDATE api_keys 
          SET last_used_at = NOW() 
          WHERE id = ${keyData.id}
        `
        
        return {
          id: keyData.user_id,
          email: keyData.email,
          authMethod: "api_key",
          apiKeyScopes: keyData.scopes as ApiScope[],
        }
      }
    }
    
    // Fall back to session authentication
    const cookieStore = await cookies()
    const token = cookieStore.get("kb_token")

    if (!token) {
      return null
    }

    const secret = new TextEncoder().encode(process.env.JWT_SECRET || "your-secret-key")
    const { payload } = await jwtVerify(token.value, secret)

    return {
      id: payload.userId as string,
      email: payload.email as string,
      authMethod: "session",
    }
  } catch (error) {
    console.error("Auth error:", error)
    return null
  }
}
