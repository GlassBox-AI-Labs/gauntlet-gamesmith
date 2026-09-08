import type { Metadata } from 'next'

export const siteName = 'Glassbox Arcade'
export const siteDescription =
  'Discover independent games made with Glassbox. Pick a game and play instantly in your browser, no account required.'

export function catalogOrigin() {
  return new URL(
    process.env.CATALOG_ORIGIN ?? 'https://gauntletgamesmith.com',
  )
}

export function socialMetadata({
  title = siteName,
  description = siteDescription,
  path,
  image,
}: {
  title?: string
  description?: string
  path: string
  image?: { url: string; alt: string }
}): Metadata {
  const fullTitle = title === siteName ? title : `${title} · ${siteName}`
  const images = [
    image ?? {
      url: '/social-card.png',
      width: 1200,
      height: 630,
      type: 'image/png',
      alt: 'Glassbox Arcade — Made here. Played here.',
    },
  ]
  return {
    title: { absolute: fullTitle },
    description,
    alternates: { canonical: path },
    openGraph: {
      type: 'website',
      locale: 'en_US',
      siteName,
      title: fullTitle,
      description,
      url: path,
      images,
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description,
      images,
    },
  }
}
