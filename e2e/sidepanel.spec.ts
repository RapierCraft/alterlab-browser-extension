import { API_KEY, TAB_IDS, expect, test } from "./fixtures";

// Extension globals exist only inside page.evaluate callbacks.
declare const chrome: any;

test.describe("chrome extension sidepanel", () => {
  test("all 9 tabs render and activate without console errors", async ({
    openSidepanel,
  }) => {
    const { page, errors } = await openSidepanel();

    await expect(page.locator("button[data-tab]")).toHaveCount(TAB_IDS.length);
    for (const id of TAB_IDS) {
      await page.locator(`button[data-tab="${id}"]`).click();
      await expect(page.locator(`#panel-${id}`)).toHaveClass(/active/);
      await expect(page.locator(`button[data-tab="${id}"]`)).toHaveClass(
        /active/,
      );
    }
    expect(errors).toEqual([]);
  });

  test("invalid API key shows an error and does not save the config", async ({
    openSidepanel,
    mockApi,
    serviceWorker,
  }) => {
    mockApi.mode = "unauthorized";
    const { page } = await openSidepanel();
    await page.locator('button[data-tab="account"]').click();
    // The manual key form lives in a collapsed "Advanced" disclosure.
    await page.locator("summary", { hasText: "Manual API key" }).click();
    await page.locator("#apiKeyInput").fill(API_KEY);
    await page.locator("#apiUrlInput").fill(mockApi.origin);
    await page.locator("#connectBtn").click();

    await expect(page.locator("#accountStatus")).toContainText(
      "Invalid API key",
    );
    await expect(page.locator("#connectBtn")).toBeEnabled();
    const stored = await serviceWorker.evaluate(() =>
      chrome.storage.local.get("apiKey"),
    );
    expect(stored.apiKey || "").toBe("");
  });

  test("rate limited connect shows a rate-limit message", async ({
    openSidepanel,
    mockApi,
  }) => {
    mockApi.mode = "rate-limited";
    const { page } = await openSidepanel();
    await page.locator('button[data-tab="account"]').click();
    // The manual key form lives in a collapsed "Advanced" disclosure.
    await page.locator("summary", { hasText: "Manual API key" }).click();
    await page.locator("#apiKeyInput").fill(API_KEY);
    await page.locator("#apiUrlInput").fill(mockApi.origin);
    await page.locator("#connectBtn").click();

    await expect(page.locator("#accountStatus")).toContainText(/rate limited/i);
    await expect(page.locator("#accountStatus")).not.toContainText(
      "Invalid API key",
    );
  });

  test("offline toggles the offline banner", async ({
    openSidepanel,
    context,
  }) => {
    const { page } = await openSidepanel();
    await expect(page.locator("#offlineBanner")).toHaveClass(/hidden/);
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.locator("#offlineBanner")).not.toHaveClass(/hidden/);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator("#offlineBanner")).toHaveClass(/hidden/);
  });

  test("self-hosted apiUrl is used for every API request", async ({
    openSidepanel,
    mockApi,
    seedConfig,
  }) => {
    await seedConfig(API_KEY, mockApi.origin);
    const apiHosts = new Set<string>();
    const { page } = await openSidepanel();
    page.on("request", (r) => {
      if (r.url().includes("/api/v1/")) apiHosts.add(new URL(r.url()).origin);
    });
    await page.locator('button[data-tab="account"]').click();
    await expect.poll(() => mockApi.requests.length).toBeGreaterThan(0);

    expect(mockApi.requests.some((r) => r.path === "/api/v1/auth/me")).toBe(
      true,
    );
    // CORS preflights (OPTIONS) never carry custom headers by design; the
    // Account tab now also lists BYOS sessions, which triggers one.
    for (const r of mockApi.requests.filter((r) => r.method !== "OPTIONS")) {
      expect(r.headers["x-api-key"] ?? "").toBe(API_KEY);
    }
    expect(Array.from(apiHosts).filter((h) => h !== mockApi.origin)).toEqual(
      [],
    );
  });
});
