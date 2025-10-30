import { cookies } from "next/headers"
import { jwtVerify } from "jose"

export async function getUser() {
  try {
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
    }
  } catch (error) {
    console.error("Auth error:", error)
    return null
  }
}
