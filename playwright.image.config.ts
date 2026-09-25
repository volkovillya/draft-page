import { defineConfig } from "@playwright/test";

// Smoke tests for the production Docker image. Run with `npm run test:image`, which builds
// the image, migrates a scratch database with the image's own runner, and starts it.
export default defineConfig({
  testDir: "tests/image",
  timeout: 30_000,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${process.env.DRAFTPAGE_IMAGE_PORT ?? 6590}`, channel: "chrome" },
});
