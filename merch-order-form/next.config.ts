import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The public order form is embedded in the Slate portal
  // (https://enroll.gs.edu/portal/merch-order), so it must allow that origin to
  // frame it. Admin pages stay unframeable: they're opened directly, and their
  // SameSite=Lax session cookie wouldn't be sent inside a cross-site iframe.
  async headers() {
    return [
      {
        source: "/order",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self' https://enroll.gs.edu" },
        ],
      },
      {
        source: "/admin/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
