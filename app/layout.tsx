import type React from "react"
import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import "./globals.css"
import QueryProvider from "@/components/query-provider"
import AutoRefreshProvider from "@/components/auto-refresh-provider"

const inter = Inter({ 
  subsets: ["latin"],
  variable: "--font-inter"
})

export const metadata: Metadata = {
  title: "Kolaybase - Database Management Made Easy",
  description: "A powerful database management interface built with Next.js",
  generator: "v0.app",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased`}>
        <QueryProvider>
          <AutoRefreshProvider>
            {children}
          </AutoRefreshProvider>
        </QueryProvider>
        <Analytics />
      </body>
    </html>
  )
}
