import { NextResponse } from "next/server"

export async function POST() {
  const response = NextResponse.json({ message: "Signed out successfully" })

  // Clear the auth cookie
  response.cookies.delete("kb_token")

  return response
}
