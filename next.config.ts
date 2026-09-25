import type { NextConfig } from "next";

const config: NextConfig = {
  // Self-contained server bundle for the Docker image (Phase 2).
  output: "standalone",
  poweredByHeader: false,
  devIndicators: false,
  // Lets a second, local-only dev server (used for UI screenshots) build into its own folder.
  distDir: process.env.DRAFTPAGE_DIST_DIR || ".next",
  turbopack: { root: import.meta.dirname },
};

export default config;
