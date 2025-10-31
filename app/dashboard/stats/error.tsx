"use client"

import { useEffect } from "react"

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-xl font-semibold">Failed to load stats</h2>
      <p className="text-muted-foreground">{error.message || "An unexpected error occurred."}</p>
      <button className="inline-flex items-center rounded-md border px-3 py-2 text-sm" onClick={() => reset()}>
        Try again
      </button>
    </div>
  )
}


