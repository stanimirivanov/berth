import { defineConfig } from "@playwright/test";
import full, { preview } from "./playwright.config";

export default defineConfig({
  ...full,
  testIgnore: [],
  testMatch: "read-only.spec.ts",
  webServer: {
    ...preview,
    env: { BERTH_UI_READ_ONLY: "1" },
  },
});
