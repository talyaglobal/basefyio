import { NextResponse } from "next/server"
import { SignJWT } from "jose"

export async function POST(request: Request) {
  try {
    const { email } = await request.json()
    if (!email) return NextResponse.json({ code: "INVALID_INPUT", message: "Email is required" }, { status: 400 })

    const magicSecret = new TextEncoder().encode(process.env.MAGIC_SECRET || process.env.JWT_SECRET || "your-secret-key")
    const token = await new SignJWT({ email, purpose: "magic_link" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("15m")
      .sign(magicSecret)

    // In production, send via email. For dev, return the link.
    const url = new URL("/api/auth/magic-link/verify", process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000")
    url.searchParams.set("token", token)

    return NextResponse.json({ success: true, link: url.toString() })
  } catch (e) {
    return NextResponse.json({ code: "SERVER_ERROR", message: "Failed to create magic link" }, { status: 500 })
  }
}


