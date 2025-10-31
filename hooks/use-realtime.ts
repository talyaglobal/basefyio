"use client"

import { useEffect, useRef } from "react"
import { kolaybase } from "@/lib/kolaybase"
import type { RealtimeEvent } from "@/types"

export function useRealtime(table: string, callback: (event: RealtimeEvent) => void) {
  const callbackRef = useRef(callback)

  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  useEffect(() => {
    if (typeof window === "undefined") return

    // Use SSE by default for simplicity
    const unsubscribe = kolaybase.realtime.subscribeSSE(table, (event) => {
      callbackRef.current(event)
    })

    return unsubscribe
  }, [table])
}

