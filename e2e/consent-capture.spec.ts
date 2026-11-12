import { API_KEY, expect, test } from "./fixtures";

// Extension globals exist only inside page.evaluate callbacks.
declare const chrome: any;
declare const AlterLabConsent: any;

// Drives the real consent.js shipped in the sidepanel document: the upload
// body can only be built after consent, then is POSTed to the mock sessions API.
test.describe("cookie capture consent flow", () => {
  test("sessions upload is blocked until consent, then succeeds with consent=true", async ({
    openSidepanel,
    mockApi,
    seedConfig,
  }) => {
    await seedConfig(API_KEY, mockApi.origin);
    const { page } = await openSidepanel();

    const blocked = await page.evaluate(async () => {
      await AlterLabConsent.revokeConsent(chrome.storage.local);
      try {
        await AlterLabConsent.buildSessionBody(chrome.storage.local, {
          domain: "example.com",
          name: "e2e",
          cookies: { a: "1" },
        });
        return "built";
      } catch (e) {
        return (e as { code?: string }).code ?? "error";
      }
    });
    expect(blocked).toBe("CONSENT_NOT_GRANTED");
    expect(
      mockApi.requests.filter(
        (r) => r.path === "/api/v1/sessions" && r.method === "POST",
      ),
    ).toHaveLength(0);

    const result = await page.evaluate(
      async ([origin, key]) => {
        await AlterLabConsent.grantConsent(chrome.storage.local);
        const body = await AlterLabConsent.buildSessionBody(
          chrome.storage.local,
          {
            domain: "example.com",
            name: "e2e",
            cookies: { a: "1" },
          },
        );
        const resp = await fetch(`${origin}/api/v1/sessions`, {
          method: "POST",
          headers: { "X-API-Key": key, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: resp.status, json: await resp.json() };
      },
      [mockApi.origin, API_KEY],
    );

    expect(result.status).toBe(201);
    const posts = mockApi.requests.filter(
      (r) => r.path === "/api/v1/sessions" && r.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body)).toMatchObject({
      domain: "example.com",
      consent: true,
    });
  });

  test("webRequest and all-hosts access stay optional (no install-time warnings)", async ({
    serviceWorker,
  }) => {
    const manifest = await serviceWorker.evaluate(() =>
      chrome.runtime.getManifest(),
    );
    expect(manifest.optional_permissions).toContain("webRequest");
    // Scheme-wildcard ceiling for per-site consent (#38934); never granted at install.
    expect(manifest.optional_host_permissions).toEqual(
      expect.arrayContaining(["https://*/*", "http://*/*"]),
    );
    expect(manifest.permissions ?? []).not.toContain("webRequest");
    expect(manifest.host_permissions ?? []).not.toContain("<all_urls>");
  });
});
