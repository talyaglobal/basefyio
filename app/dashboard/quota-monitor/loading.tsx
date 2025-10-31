export default function Loading() {
  return (
    <div className="p-6 space-y-4">
      <div className="h-6 w-40 bg-muted animate-pulse rounded" />
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-muted animate-pulse rounded" />
        ))}
      </div>
      <div className="h-64 bg-muted animate-pulse rounded" />
    </div>
  )
}


