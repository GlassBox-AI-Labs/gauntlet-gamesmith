import type { NextConfig } from 'next'
const config: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ['@gauntlet/data', '@gauntlet/db', '@gauntlet/publishing'],
}
export default config
