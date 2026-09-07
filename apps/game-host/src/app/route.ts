export function GET() {
  return Response.json(
    { service: 'glassbox-game-host' },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
