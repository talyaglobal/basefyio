"use client"

import { useEffect } from "react"
import { kolaybase } from "@/lib/kolaybase"

export default function AutoRefreshProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    kolaybase.startAutoRefresh()
  }, [])

  return <>{children}</>
}


