import Link from 'next/link'
import { Button } from '@gauntlet/ui/button'
export default function NotFound() {
  return (
    <div className="space-y-5">
      <h1 className="text-3xl">This game is unavailable.</h1>
      <p className="text-muted-foreground">It may have been unpublished.</p>
      <Button asChild>
        <Link data-testid="unavailable-browse" href="/">
          Browse games
        </Link>
      </Button>
    </div>
  )
}
