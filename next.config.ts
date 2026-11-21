import type { NextConfig } from "next"

// Extra hosts allowed to call Server Actions. Behind a reverse proxy that forwards
// the public host (x-forwarded-host), which Coolify, Caddy and Traefik all do, you
// need none. This is read at build time. See docs/SELF_HOSTING.md.
const extraOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

const nextConfig: NextConfig = {
  // A self-contained server in .next/standalone, which is what the Dockerfile ships.
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    serverActions: { allowedOrigins: extraOrigins, bodySizeLimit: "1mb" },
  },
  // The Content-Security-Policy needs a fresh nonce per request, so it is set in
  // proxy.ts. These are the headers that never change.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          // Browsers ignore this over plain http, so it is safe for local use.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ]
  },
}

export default nextConfig
