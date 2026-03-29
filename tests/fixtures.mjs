/**
 * AlterLab Connect — Playwright Test Fixtures
 *
 * Provides a shared `context` and `extensionId` fixture for all tests.
 * Launches Chromium with the built extension loaded via --load-extension.
 *
 * Prerequisites:
 *   - Extension must be built first: `npm run build:chrome`
 *   - The dist/chrome/ directory must exist with a valid manifest.json
 */

import { test as base, chromium } from "@playwright/test";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(__dirname, "..", "dist", "chrome");

/**
 * Custom test fixture that:
 * 1. Verifies the Chrome build exists
 * 2. Launches a persistent Chromium context with the extension loaded
 * 3. Discovers the extension ID from the service worker
 * 4. Provides `context`, `extensionId`, and a `getPopupPage()` helper
 */
export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!existsSync(join(EXTENSION_PATH, "manifest.json"))) {
      throw new Error(
        `Extension build not found at ${EXTENSION_PATH}. Run "npm run build:chrome" first.`,
      );
    }

    const userDataDir = mkdtempSync(join(tmpdir(), "alterlab-test-"));

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // Required for extensions
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-first-run",
        "--disable-gpu",
        "--disable-default-apps",
        "--disable-popup-blocking",
      ],
    });

    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    // Wait for the service worker to register — this gives us the extension ID.
    // In MV3 Chrome extensions, the background script runs as a service worker
    // accessible via chrome.runtime.getURL or the service workers list.
    let serviceWorker;

    // Check if a service worker is already registered
    const existingWorkers = context.serviceWorkers();
    if (existingWorkers.length > 0) {
      serviceWorker = existingWorkers[0];
    } else {
      // Wait for the service worker to appear (extension loading can take a moment)
      serviceWorker = await context.waitForEvent("serviceworker", {
        timeout: 10_000,
      });
    }

    const extensionId = serviceWorker.url().split("/")[2];
    await use(extensionId);
  },

  /**
   * Helper to open the extension popup as a page.
   * Playwright can't click the browser action icon directly, so we navigate
   * to the popup URL (chrome-extension://{id}/popup.html).
   */
  popupPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "domcontentloaded",
    });
    await use(page);
    await page.close();
  },
});

export { expect } from "@playwright/test";
