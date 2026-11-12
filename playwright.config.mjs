import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// The specs are mirrored from the monorepo and load the unpacked Chrome tree.
process.env.EXTENSION_DIR ??= fileURLToPath(new URL("./chrome-extension", import.meta.url));

/**
 * Playwright smoke suite for the unpacked Chrome build (mirrors the AlterLab
 * monorepo's web/e2e-extension). Specs launch their own persistent Chromium
 * context (extensions need headful Chromium: run under xvfb in CI) and a local
 * mock API, so nothing here talks to production.
 * Firefox is covered by the static parity tests in extension-tests/.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  timeout: 60_000,
  projects: [{ name: "chromium-extension" }],
});
