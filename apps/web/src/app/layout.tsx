import type { Metadata } from 'next'
import { catalogOrigin, siteDescription, siteName } from '@/lib/social-metadata'
import './globals.css'
export const metadata: Metadata = {
  metadataBase: catalogOrigin(),
  applicationName: siteName,
  title: { default: siteName, template: `%s · ${siteName}` },
  description: siteDescription,
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
