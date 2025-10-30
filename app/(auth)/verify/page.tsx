"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Database, Mail } from "lucide-react"

export default function VerifyPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <div className="flex justify-center mb-4">
            <div className="flex items-center gap-2">
              <Database className="h-8 w-8 text-primary" />
              <span className="text-2xl font-bold">Kolaybase</span>
            </div>
          </div>
          <div className="flex justify-center mb-6">
            <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Mail className="h-8 w-8 text-primary" />
            </div>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Check your email</h1>
          <p className="text-muted-foreground mt-2 max-w-sm mx-auto">
            We sent you a verification link. Click the link in the email to verify your account and get started.
          </p>
        </div>

        <div className="space-y-4">
          <div className="p-4 bg-muted rounded-lg text-sm text-left space-y-2">
            <p className="font-medium">{"Didn't receive the email?"}</p>
            <ul className="list-disc list-inside text-muted-foreground space-y-1">
              <li>Check your spam folder</li>
              <li>Make sure you entered the correct email</li>
              <li>Wait a few minutes and check again</li>
            </ul>
          </div>

          <Button variant="outline" className="w-full bg-transparent">
            Resend verification email
          </Button>

          <Link href="/sign-in">
            <Button variant="ghost" className="w-full">
              Back to sign in
            </Button>
          </Link>
        </div>
      </div>
    </div>
  )
}
