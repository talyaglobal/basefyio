import { type NextRequest, NextResponse } from "next/server"
import { mockUser } from "@/lib/mock-data"

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json()

    // Mock authentication - accept any credentials
    if (email && password) {
      const token = "mock_jwt_token_" + Date.now()

      const response = NextResponse.json({
        user: mockUser,
        token,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })

      // Set httpOnly cookie
      response.cookies.set("kb_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60, // 7 days
        path: "/",
      })

      return response
    }

    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
