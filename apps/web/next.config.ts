import type { NextConfig } from 'next'
const config: NextConfig = {
  transpilePackages: [
    '@gauntlet/ui',
    '@gauntlet/data',
    '@gauntlet/db',
    '@gauntlet/publishing',
  ],
}
export default config
