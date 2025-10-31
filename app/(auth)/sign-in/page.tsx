"use client"

import type React from "react"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/hooks/use-toast"
import { useAuthStore } from "@/store/auth-store"
import { mockOrganizations, mockProjects } from "@/lib/mock-data"
import { Database, Zap } from "lucide-react"
import { Github, Chrome } from "lucide-react"

export default function SignInPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [rememberMe, setRememberMe] = useState(false)
  const [mfaRequired, setMfaRequired] = useState(false)
  const [mfaToken, setMfaToken] = useState("")
  const [useRecoveryCode, setUseRecoveryCode] = useState(false)
  const [loading, setLoading] = useState(false)
  const [bypassLoading, setBypassLoading] = useState(false)
  const router = useRouter()
  const { toast } = useToast()
  const { setUser, setCurrentOrg, setCurrentProject } = useAuthStore()

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    try {
      const response = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          email, 
          password, 
          mfaToken: mfaRequired && !useRecoveryCode ? mfaToken : undefined,
          recoveryCode: mfaRequired && useRecoveryCode ? mfaToken : undefined,
        }),
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        if (response.status === 401 && err?.code === "REQUIRE_MFA") {
          setMfaRequired(true)
          throw new Error("MFA required")
        }
        throw new Error(err?.message || "Invalid credentials")
      }

      const data = await response.json()

      setUser(data.user)
      setCurrentOrg(mockOrganizations[0])
      setCurrentProject(mockProjects[0])

      toast({ title: "Welcome back!", description: "Successfully signed in to Kolaybase." })

      router.push("/dashboard")
    } catch (error) {
      toast({ title: "Error", description: mfaRequired ? "Enter your MFA code" : "Invalid email or password", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  const handleBypassLogin = async () => {
    if (bypassLoading) return // Prevent multiple clicks
    
    console.log("[v0] Bypass button clicked")
    setBypassLoading(true)
    
    try {
      const response = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "admin@kolaybase.com",
          password: "bypass",
        }),
      })

      console.log("[v0] Bypass API response status:", response.status)

      if (response.ok) {
        const data = await response.json()
        console.log("[v0] Bypass API response data:", data)

        setUser(data.user)
        setCurrentOrg(mockOrganizations[0])
        setCurrentProject(mockProjects[0])

        toast({
          title: "Bypassed Authentication",
          description: "Logged in instantly for development.",
          variant: "default",
        })

        console.log("[v0] Redirecting to dashboard...")
        router.push("/dashboard")
      } else {
        console.error("[v0] Bypass failed with status:", response.status)
        const errorData = await response.json().catch(() => ({}))
        toast({
          title: "Bypass Failed",
          description: errorData?.message || `Server responded with status ${response.status}`,
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("[v0] Bypass login error:", error)
      toast({
        title: "Bypass Error",
        description: "Network error occurred. Please try again.",
        variant: "destructive",
      })
    } finally {
      setBypassLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <div className="flex justify-center mb-4">
            <div className="flex items-center gap-2">
              <Database className="h-8 w-8 text-primary" />
              <span className="text-2xl font-bold">Kolaybase</span>
            </div>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Sign in to your account</h1>
          <p className="text-muted-foreground mt-2">Enter your credentials to access the console</p>
        </div>

        <form onSubmit={handleSignIn} className="space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <Link href="/recover" className="text-sm text-primary hover:underline">
                  Forgot password?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>

            {mfaRequired && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="mfa">{useRecoveryCode ? "Recovery Code" : "MFA Code"}</Label>
                  <button
                    type="button"
                    onClick={() => {
                      setUseRecoveryCode(!useRecoveryCode)
                      setMfaToken("")
                    }}
                    className="text-xs text-primary hover:underline"
                  >
                    {useRecoveryCode ? "Use MFA code" : "Use recovery code"}
                  </button>
                </div>
                <Input
                  id="mfa"
                  placeholder={useRecoveryCode ? "Enter recovery code" : "123 456"}
                  value={mfaToken}
                  onChange={(e) => setMfaToken(e.target.value)}
                  inputMode={useRecoveryCode ? "text" : "numeric"}
                  pattern={useRecoveryCode ? undefined : "[0-9]*"}
                />
              </div>
            )}

            <div className="flex items-center space-x-2">
              <Checkbox
                id="remember"
                checked={rememberMe}
                onCheckedChange={(checked) => setRememberMe(checked as boolean)}
              />
              <Label htmlFor="remember" className="text-sm font-normal cursor-pointer">
                Remember me for 30 days
              </Label>
            </div>
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </Button>

          <Button
            type="button"
            onClick={handleBypassLogin}
            className="w-full bg-green-600 hover:bg-green-700 text-white"
            variant="default"
            disabled={bypassLoading}
          >
            <Zap className="h-4 w-4 mr-2" />
            {bypassLoading ? "Bypassing..." : "Bypass Login (Dev Mode)"}
          </Button>
        </form>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Button asChild variant="outline">
            <a href="/api/auth/oauth/github/authorize"><Github className="h-4 w-4 mr-2" /> Continue with GitHub</a>
          </Button>
          <Button asChild variant="outline">
            <a href="/api/auth/oauth/google/authorize"><Chrome className="h-4 w-4 mr-2" /> Continue with Google</a>
          </Button>
        </div>

        <p className="text-center text-sm text-muted-foreground">
          {"Don't have an account? "}
          <Link href="/sign-up" className="text-primary hover:underline font-medium">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  )
}
