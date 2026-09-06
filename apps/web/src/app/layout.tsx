import type { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'
import { Brand } from '@gauntlet/ui/brand'
import logo from '../app-logo.png'
import './globals.css'
export const metadata: Metadata = {
  title: { default: 'Glassbox Arcade', template: '%s · Glassbox Arcade' },
  description:
    'Games made with Glassbox. Browse and play, no account required.',
}
export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body>
        <header className="flex min-h-20 items-center justify-between gap-4 border-b px-5 sm:px-10">
          <Link data-testid="catalog-home" href="/">
            <Brand
              logo={<Image src={logo} alt="" width={40} height={40} />}
              suffix="arcade"
            />
          </Link>
          <nav className="flex gap-5 text-sm">
            <Link data-testid="catalog-games" href="/">
              Games
            </Link>
          </nav>
        </header>
        <main className="mx-auto min-h-[calc(100dvh-160px)] max-w-7xl px-5 py-12 sm:px-10">
          {children}
        </main>
        <footer className="flex justify-between gap-4 border-t px-5 py-6 text-xs text-muted-foreground sm:px-10">
          <span>Glassbox Arcade</span>
          <span>Made here. Played here.</span>
        </footer>
      </body>
    </html>
  )
}
