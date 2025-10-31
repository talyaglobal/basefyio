export default function Loading() {
  return (
    <div className="space-y-4 p-6">
      <div className="h-8 w-56 bg-muted rounded animate-pulse" />
      <div className="h-4 w-80 bg-muted rounded animate-pulse" />
      <div className="grid gap-4 md:grid-cols-3">
        <div className="h-40 bg-muted rounded animate-pulse" />
        <div className="h-40 bg-muted rounded animate-pulse" />
        <div className="h-40 bg-muted rounded animate-pulse" />
      </div>
    </div>
  )
}


