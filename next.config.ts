import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    // CI type-checks the whole tree (`npm run typecheck`) before any image is
    // built, and the deploy job only runs once that passed — so the copy of
    // `tsc` that `next build` runs is duplicated work. The Dockerfile sets
    // SKIP_TYPECHECK=1 to skip it there; a local or CI `next build` with the
    // variable unset still type-checks as before.
    ignoreBuildErrors: process.env.SKIP_TYPECHECK === "1",
  },
  // Inlines the build's version into process.env.APP_VERSION wherever it's
  // referenced — see src/lib/app-version.ts. Needed because the standalone
  // runtime image never ships package.json itself, so there's nothing to read
  // at request time otherwise. This is the "app version" attached to a
  // support-form submission (src/lib/actions/support.ts) so a bug report
  // carries a build reference without a round trip back to whoever filed it.
  //
  // APP_VERSION wins when set (the deploy passes a git SHA as a build arg);
  // otherwise it falls back to package.json's "version", which npm exposes as
  // npm_package_version for any script run via `npm run …` — which is how the
  // Dockerfile's build stage invokes this.
  env: {
    APP_VERSION: process.env.APP_VERSION || process.env.npm_package_version,
  },
  async headers() {
    return [
      {
        // The signing token lives in this path (src/app/(sign)/sign/[token]).
        // `no-referrer` stops it travelling in a Referer header to anything
        // the page loads or links to; `no-store` keeps it out of shared
        // caches; `X-Robots-Tag` backs up the route's own `robots` metadata
        // (src/app/(sign)/layout.tsx) for crawlers that ignore that tag.
        source: "/sign/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
    ];
  },
};

export default nextConfig;
