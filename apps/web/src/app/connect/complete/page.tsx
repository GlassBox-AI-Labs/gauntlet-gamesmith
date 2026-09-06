export default function ConnectionCompletePage() {
  return (
    <section className="mx-auto max-w-md rounded-xl border bg-card p-8">
      <h1 className="mb-3 text-2xl font-semibold">Return to the desktop app</h1>
      <p role="status" className="text-muted-foreground">
        Connection approved. Electron will finish signing in. You can close this
        tab.
      </p>
    </section>
  )
}
