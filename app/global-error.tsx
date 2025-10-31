"use client"

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html>
      <body>
        <div className="p-6 space-y-4">
          <h2 className="text-xl font-semibold">Critical error</h2>
          <p className="text-muted-foreground">{error.message || "An unexpected error occurred."}</p>
          <button className="inline-flex items-center rounded-md border px-3 py-2 text-sm" onClick={() => reset()}>
            Reload
          </button>
        </div>
      </body>
    </html>
  )
}


