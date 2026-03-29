/**
 * AlterLab Connect — Playwright Configuration
 *
 * Extension testing uses Chromium persistent context with --load-extension.
 * Firefox extension testing is not supported by Playwright — see TESTING.md
 * for the manual QA checklist.
 *
 * Usage:
 *   npm test              # build + run tests (headless)
 *   npm run test:headed   # build + run tests (visible browser)
 */

import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: join(__dirname, "tests"),
  timeout: 30_000,
  retries: 0,
  workers: 1, // Extensions require serial execution (one browser context)
  reporter: [["list"], ["html", { open: "never" }]],

  // No "projects" — we configure the browser context manually in fixtures
  // because extension loading requires BrowserType.launchPersistentContext(),
  // which is incompatible with Playwright's built-in project/browser config.
  use: {
    headless: false, // Extensions cannot run in headless Chromium
    viewport: { width: 400, height: 600 },
    actionTimeout: 10_000,
  },
});
