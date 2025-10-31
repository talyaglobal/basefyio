import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { securityHeaders } from "@/lib/api-utils"

export function middleware(request: NextRequest) {
  const token = request.cookies.get("kb_token")
  const { pathname } = request.nextUrl

  console.log("[v0] Middleware - pathname:", pathname, "has token:", !!token)

  // Protect dashboard routes
  if (pathname.startsWith("/dashboard")) {
    if (!token) {
      console.log("[v0] No token, redirecting to sign-in")
      return NextResponse.redirect(new URL("/sign-in", request.url))
    }
    console.log("[v0] Token found, allowing access to dashboard")
  }

  // Redirect to dashboard if already authenticated
  if (["/sign-in", "/sign-up"].includes(pathname)) {
    if (token) {
      return NextResponse.redirect(new URL("/dashboard", request.url))
    }
  }

  const res = NextResponse.next()
  const headers = securityHeaders()
  for (const [k, v] of Object.entries(headers)) {
    res.headers.set(k, v)
  }
  return res
}

export const config = {
  matcher: ["/dashboard/:path*", "/sign-in", "/sign-up"],
}
