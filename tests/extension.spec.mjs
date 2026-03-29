/**
 * AlterLab Connect — Chrome Extension E2E Tests
 *
 * Tests run against the Chrome dist build loaded into Chromium via
 * Playwright persistent context. Covers popup rendering, view routing,
 * API key manual entry, and basic UI interactions.
 *
 * Usage:
 *   npm test                    # headless build + run
 *   npx playwright test --ui    # interactive test runner
 */

import { test, expect } from "./fixtures.mjs";

// ---------------------------------------------------------------------------
// Popup — Structure & Rendering
// ---------------------------------------------------------------------------

test.describe("Popup: Structure", () => {
  test("popup page loads without errors", async ({ popupPage }) => {
    // Title should be set
    await expect(popupPage).toHaveTitle("AlterLab Connect");
  });

  test("header renders with logo, title, and version badge", async ({
    popupPage,
  }) => {
    // Header elements
    const logo = popupPage.locator(".al-header-logo");
    await expect(logo).toBeVisible();

    const title = popupPage.locator(".al-header-title");
    await expect(title).toHaveText("AlterLab Connect");

    const version = popupPage.locator("#versionBadge");
    await expect(version).toBeVisible();
    // Version badge should be populated (not the placeholder)
    const text = await version.textContent();
    expect(text).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  test("footer has settings, theme toggle, and side panel buttons", async ({
    popupPage,
  }) => {
    const settingsBtn = popupPage.locator("#settingsBtn");
    await expect(settingsBtn).toBeVisible();
    await expect(settingsBtn).toContainText("Settings");

    const themeToggle = popupPage.locator("#themeToggle");
    await expect(themeToggle).toBeVisible();

    const panelBtn = popupPage.locator("#openPanelBtn");
    await expect(panelBtn).toBeVisible();
    await expect(panelBtn).toContainText("Side panel");
  });

  test("spectrum bar renders at bottom", async ({ popupPage }) => {
    const bar = popupPage.locator(".al-spectrum-bar");
    await expect(bar).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Popup — View Routing (Login vs Capture)
// ---------------------------------------------------------------------------

test.describe("Popup: View Routing", () => {
  test("shows login view when no API key is configured", async ({
    popupPage,
  }) => {
    // With no stored API key, the popup should show the login view
    // (or auth check view briefly, then login view)
    const loginView = popupPage.locator("#loginView");

    // Wait for auth check to complete and login view to appear
    await expect(loginView).toBeVisible({ timeout: 5_000 });

    // Login button should be present
    const loginBtn = popupPage.locator("#loginBtn");
    await expect(loginBtn).toBeVisible();
    await expect(loginBtn).toContainText("Sign in");
  });

  test("signup link is present in login view", async ({ popupPage }) => {
    const loginView = popupPage.locator("#loginView");
    await expect(loginView).toBeVisible({ timeout: 5_000 });

    const signupLink = popupPage.locator("#signupLink");
    await expect(signupLink).toBeVisible();
    await expect(signupLink).toHaveText("Create one free");
  });

  test("capture view is hidden when not authenticated", async ({
    popupPage,
  }) => {
    // Wait for login view to be visible first
    await expect(popupPage.locator("#loginView")).toBeVisible({
      timeout: 5_000,
    });

    // Capture view should be hidden
    const captureView = popupPage.locator("#captureView");
    await expect(captureView).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Popup — Manual API Key Flow
// ---------------------------------------------------------------------------

test.describe("Popup: API Key Input", () => {
  test("advanced manual API key section is collapsed by default", async ({
    popupPage,
  }) => {
    await expect(popupPage.locator("#loginView")).toBeVisible({
      timeout: 5_000,
    });

    // The details element should exist but be collapsed
    const details = popupPage.locator("#loginView details");
    await expect(details).toBeVisible();

    // The inner input should not be visible (collapsed)
    const apiKeyInput = popupPage.locator("#apiKeyInput");
    await expect(apiKeyInput).not.toBeVisible();
  });

  test("expanding advanced section reveals API key input", async ({
    popupPage,
  }) => {
    await expect(popupPage.locator("#loginView")).toBeVisible({
      timeout: 5_000,
    });

    // Click the summary to expand
    const summary = popupPage.locator("#loginView details summary");
    await summary.click();

    // Now the API key input should be visible
    const apiKeyInput = popupPage.locator("#apiKeyInput");
    await expect(apiKeyInput).toBeVisible();
    await expect(apiKeyInput).toHaveAttribute("placeholder", "sk_live_...");

    // Save button should be visible
    const saveBtn = popupPage.locator("#saveKeyBtn");
    await expect(saveBtn).toBeVisible();
    await expect(saveBtn).toHaveText("Save");
  });

  test("API URL input has correct default placeholder", async ({
    popupPage,
  }) => {
    await expect(popupPage.locator("#loginView")).toBeVisible({
      timeout: 5_000,
    });

    // Expand advanced section
    await popupPage.locator("#loginView details summary").click();

    const apiUrlInput = popupPage.locator("#apiUrlInput");
    await expect(apiUrlInput).toBeVisible();
    await expect(apiUrlInput).toHaveAttribute(
      "placeholder",
      "https://alterlab.io",
    );
  });

  test("can type into API key input field", async ({ popupPage }) => {
    await expect(popupPage.locator("#loginView")).toBeVisible({
      timeout: 5_000,
    });

    // Expand advanced section
    await popupPage.locator("#loginView details summary").click();

    const apiKeyInput = popupPage.locator("#apiKeyInput");
    await apiKeyInput.fill("sk_live_test_key_12345");
    await expect(apiKeyInput).toHaveValue("sk_live_test_key_12345");
  });
});

// ---------------------------------------------------------------------------
// Popup — Theme Toggle
// ---------------------------------------------------------------------------

test.describe("Popup: Theme", () => {
  test("theme toggle switches between light and dark", async ({
    popupPage,
  }) => {
    const toggle = popupPage.locator("#themeToggle");
    await expect(toggle).toBeVisible();

    // Get initial theme state
    const initialTheme = await popupPage.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );

    // Click toggle
    await toggle.click();

    // Theme should have changed
    const newTheme = await popupPage.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );

    // If initial was dark (or null/unset), new should be light, and vice versa
    expect(newTheme).not.toBe(initialTheme);
  });
});

// ---------------------------------------------------------------------------
// Background — Service Worker
// ---------------------------------------------------------------------------

test.describe("Background: Service Worker", () => {
  test("service worker registers successfully", async ({
    context,
    extensionId,
  }) => {
    // extensionId fixture already validates that a service worker exists
    expect(extensionId).toBeTruthy();
    expect(extensionId).toMatch(/^[a-z]{32}$/);
  });

  test("extension ID is consistent across pages", async ({
    context,
    extensionId,
  }) => {
    // Open popup via extension URL and verify it loads within the extension
    const page = await context.newPage();
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    await page.goto(popupUrl, { waitUntil: "domcontentloaded" });
    expect(page.url()).toContain(extensionId);
    await page.close();
  });
});

// ---------------------------------------------------------------------------
// Side Panel (Chrome)
// ---------------------------------------------------------------------------

test.describe("Side Panel", () => {
  test("sidepanel.html loads via extension URL", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`, {
      waitUntil: "domcontentloaded",
    });

    // Side panel should have loaded — verify it has expected structure
    await expect(page).toHaveTitle(/AlterLab/);
    await page.close();
  });
});
