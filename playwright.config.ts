import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "firefox",
      use: { browserName: "firefox", baseURL: "http://127.0.0.1:3101" },
    },
    {
      name: "webkit",
      use: { browserName: "webkit", baseURL: "http://127.0.0.1:3102" },
    },
  ],
  // Isolate database state and real authentication quotas between browsers.
  webServer: [3100, 3101, 3102].map((port) => ({
    command: "node --import tsx e2e/server.ts",
    url: `http://127.0.0.1:${port}/api/health`,
    env: { PORT: String(port) },
    reuseExistingServer: false,
  })),
});
