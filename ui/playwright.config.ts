import { defineConfig } from "@playwright/test";
export const preview = {
  command: "cd .. && node dist/scripts/history-server.js",
  url: "http://127.0.0.1:4201",
  reuseExistingServer: false,
  timeout: 120000,
};

export default defineConfig({
  testDir: "./tests",
  testIgnore: "read-only.spec.ts",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4201", browserName: "chromium" },
  webServer: preview,
});
