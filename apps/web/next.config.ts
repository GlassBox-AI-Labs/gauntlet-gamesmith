import type { NextConfig } from 'next'

// Match scripts/local.mjs; hosted deployments supply GAME_ORIGIN at build time.
const gameOrigin = process.env.GAME_ORIGIN ?? (process.env.VERCEL
  ? undefined
  : `http://${process.env.CATALOG_HOST ?? '127.0.0.1'}:${process.env.GAME_PORT ?? '4311'}`)

const config: NextConfig = {
  images: {
    remotePatterns: gameOrigin ? [new URL('/play/**', gameOrigin)] : [],
    // Only the explicitly configured local game host needs private-network access.
    dangerouslyAllowLocalIP: !process.env.VERCEL && !!gameOrigin && new URL(gameOrigin).protocol === 'http:',
    maximumRedirects: 0,
    minimumCacheTTL: 60,
  },
  transpilePackages: [
    '@gauntlet/ui',
    '@gauntlet/data',
    '@gauntlet/db',
    '@gauntlet/publishing',
    '@glassbox/multiplayer',
  ],
}
export default config
