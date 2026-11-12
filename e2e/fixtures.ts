import { test as base, chromium } from "@playwright/test";
import type { BrowserContext, Page, Worker } from "@playwright/test";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

declare const chrome: any;

// EXTENSION_DIR lets the public satellite repo run these specs against its own
// mirror of the extension (see devdocs/ECOSYSTEM.md -> Browser extension).
const EXTENSION_DIR =
  process.env.EXTENSION_DIR ??
  path.resolve(process.cwd(), "../tools/chrome-extension");

export const TAB_IDS = [
  "inspect",
  "scrape",
  "meta",
  "robots",
  "cookies",
  "network",
  "selector",
  "account",
  "tools",
] as const;

export const API_KEY = "sk_live_e2e_fixture_key";

export type MockMode = "ok" | "unauthorized" | "rate-limited";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface MockApi {
  origin: string;
  mode: MockMode;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Local stand-in for the AlterLab API; records every request it receives. */
export async function startMockApi(): Promise<MockApi> {
  const requests: RecordedRequest[] = [];
  const api = { mode: "ok" as MockMode, requests } as MockApi;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url || "/", "http://mock");
      requests.push({
        method: req.method || "GET",
        path: url.pathname,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "X-API-Key, Content-Type");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
      res.setHeader("Content-Type", "application/json");
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (api.mode === "unauthorized") {
        res.statusCode = 401;
        res.end(JSON.stringify({ detail: "Invalid API key" }));
        return;
      }
      if (api.mode === "rate-limited") {
        res.statusCode = 429;
        res.end(JSON.stringify({ detail: "Rate limit exceeded" }));
        return;
      }
      if (url.pathname === "/api/v1/auth/me") {
        res.end(
          JSON.stringify({ email: "e2e@example.com", credits_remaining: 12.5 }),
        );
      } else if (url.pathname === "/api/v1/sessions" && req.method === "POST") {
        res.statusCode = 201;
        res.end(JSON.stringify({ session_id: "sess_e2e_1" }));
      } else if (url.pathname === "/api/v1/sessions") {
        res.end(JSON.stringify({ sessions: [] }));
      } else {
        res.end(JSON.stringify({}));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string")
    throw new Error("mock API failed to bind");
  api.origin = `http://127.0.0.1:${addr.port}`;
  api.close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  return api;
}

export interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  mockApi: MockApi;
  /** Open the sidepanel document as a tab (headless Chromium has no side panel UI). */
  openSidepanel: () => Promise<{ page: Page; errors: string[] }>;
  /** Persist apiKey/apiUrl the way the extension does. */
  seedConfig: (apiKey: string, apiUrl: string) => Promise<void>;
}

export const test = base.extend<ExtensionFixtures>({
  context: async ({}, use) => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), "alterlab-ext-e2e-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        "--headless=new",
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });
    await use(context);
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  },
  serviceWorker: async ({ context }, use) => {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    await use(worker);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
  mockApi: async ({}, use) => {
    const api = await startMockApi();
    await use(api);
    await api.close();
  },
  seedConfig: async ({ serviceWorker }, use) => {
    await use(async (apiKey, apiUrl) => {
      await serviceWorker.evaluate(
        ([k, u]) => chrome.storage.local.set({ apiKey: k, apiUrl: u }),
        [apiKey, apiUrl],
      );
    });
  },
  openSidepanel: async ({ context, extensionId, serviceWorker }, use) => {
    await use(async () => {
      // A fresh profile shows the first-run onboarding carousel, a full-screen
      // overlay that intercepts every click. Mark it seen, as a returning user.
      await serviceWorker.evaluate(() =>
        chrome.storage.local.set({ hasSeenOnboarding: true }),
      );
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
      });
      await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await page.waitForLoadState("domcontentloaded");
      return { page, errors };
    });
  },
});

export { expect } from "@playwright/test";
