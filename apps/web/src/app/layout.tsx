import type { Metadata } from 'next'
import './globals.css'
export const metadata: Metadata = {
  title: { default: 'Gauntlet Gamesmith', template: '%s · Gauntlet Gamesmith' },
  description:
    'Type a sentence. Play a game. A Mac app that builds, judges, and rebuilds browser games.',
}
export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  )
}
