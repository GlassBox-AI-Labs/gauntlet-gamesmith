import type { NextConfig } from 'next'
const config: NextConfig = {
  transpilePackages: [
    '@gauntlet/ui',
    '@gauntlet/data',
    '@gauntlet/db',
    '@gauntlet/publishing',
    '@gauntlet/multiplayer',
  ],
}
export default config
