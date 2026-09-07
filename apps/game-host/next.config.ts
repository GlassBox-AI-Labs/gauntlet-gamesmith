import type { NextConfig } from 'next'
const config: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ['@gauntlet/data', '@gauntlet/db', '@gauntlet/publishing', '@gauntlet/multiplayer'],
}
export default config
