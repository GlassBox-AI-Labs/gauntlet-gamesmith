export default function Loading() {
  return (
    <div role="status" className="animate-pulse space-y-6">
      <p className="text-muted-foreground">Loading the arcade…</p>
      <div className="h-12 w-2/3 rounded bg-muted" />
      <div className="grid gap-6 sm:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="aspect-square rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  )
}
