"use client"

import type React from "react"

import { useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import { Database, ArrowLeft } from "lucide-react"

export default function RecoverPage() {
  const [email, setEmail] = useState("")
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const { toast } = useToast()

  const handleRecover = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    // Simulate API call
    setTimeout(() => {
      setSent(true)
      toast({
        title: "Recovery email sent",
        description: "Check your inbox for password reset instructions.",
      })
      setLoading(false)
    }, 1000)
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
          <h1 className="text-3xl font-bold tracking-tight">Reset your password</h1>
          <p className="text-muted-foreground mt-2">
            {sent ? "We sent you an email with instructions" : "Enter your email to receive reset instructions"}
          </p>
        </div>

        {!sent ? (
          <form onSubmit={handleRecover} className="space-y-6">
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

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Sending..." : "Send reset instructions"}
            </Button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="p-4 bg-muted rounded-lg text-sm text-center">
              <p>
                If an account exists for <strong>{email}</strong>, you will receive password reset instructions shortly.
              </p>
            </div>
            <Button variant="outline" className="w-full bg-transparent" onClick={() => setSent(false)}>
              Try another email
            </Button>
          </div>
        )}

        <Link
          href="/sign-in"
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to sign in
        </Link>
      </div>
    </div>
  )
}
