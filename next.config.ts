import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  images: {
    // SVG icons served directly from /public/assets/icons/
    unoptimized: true,
  },
  experimental: {
    // Tighten serverless behavior; keep API routes server-only.
  },
}

export default config
