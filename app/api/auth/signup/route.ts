import { type NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json()

    // Mock signup - accept any credentials
    if (email && password) {
      return NextResponse.json({
        message: "Account created successfully. Please check your email to verify.",
        email,
      })
    }

    return NextResponse.json({ error: "Invalid input" }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
