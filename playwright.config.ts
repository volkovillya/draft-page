import { defineConfig, devices } from "@playwright/test";
import { E2E_DATABASE_URL } from "./tests/e2e/global-setup";

// Browser tests run against a separate local dev server (port 6599, own build folder, own
// database) with the dev sign-in enabled for that process only. Your dev server on 6500 and
// its data are never touched. Needs `npm run test:db` running.
const PORT = 6599;

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Uses the locally installed Google Chrome, so no browser download is needed.
    channel: "chrome",
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
  webServer: {
    command: `next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: true,
    timeout: 180_000,
    // Its own database, so browser tests never touch your local development data.
    env: {
      DRAFTPAGE_DEV_AUTH: "on",
      DRAFTPAGE_DIST_DIR: ".next-e2e",
      DRAFTPAGE_DATABASE_URL: E2E_DATABASE_URL,
      DRAFTPAGE_DATABASE_SSL: "false",
    },
  },
});
