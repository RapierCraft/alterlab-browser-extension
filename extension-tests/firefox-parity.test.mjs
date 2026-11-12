import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const tabs = (html) =>
  [...html.matchAll(/<button[^>]*\bdata-tab="([a-z]+)"/g)].map((m) => m[1]);

const EXPECTED_TABS = [
  "inspect",
  "scrape",
  "meta",
  "robots",
  "cookies",
  "network",
  "selector",
  "account",
  "tools",
];

test("firefox manifest is valid JSON with a sidebar action", () => {
  const m = JSON.parse(read("firefox-extension/manifest.json"));
  assert.ok(m.version);
  assert.ok(
    m.sidebar_action,
    "firefox uses sidebar_action, not a panel window",
  );
  assert.ok(m.optional_permissions.includes("webRequest"));
  assert.ok(!(m.permissions || []).includes("webRequest"));
});

// Firefox's sidepanel has diverged from Chrome's (headers/capture/job instead
// of robots/network-split); the matrix documents this. Pin each browser's
// current tab set and require a panel per tab so a half-removed tab fails.
const TABS_BY_BROWSER = {
  "chrome-extension": EXPECTED_TABS,
  "firefox-extension": [
    "inspect",
    "scrape",
    "meta",
    "cookies",
    "headers",
    "network",
    "selector",
    "capture",
    "job",
    "account",
    "tools",
  ],
};

for (const [ext, expected] of Object.entries(TABS_BY_BROWSER)) {
  test(`${ext} sidepanel tabs each have a panel`, () => {
    const html = read(`${ext}/sidepanel.html`);
    assert.deepEqual(tabs(html), expected);
    for (const id of expected) {
      assert.match(html, new RegExp(`id="panel-${id}"`));
    }
  });
}

test("firefox background never opens a panel window", () => {
  const src = read("firefox-extension/background.js");
  assert.match(src, /sidebarAction/);
  assert.ok(!/windows\.create/.test(src));
});

test("connect maps HTTP 429 to a rate-limit message in both browsers", () => {
  for (const ext of ["chrome-extension", "firefox-extension"]) {
    const src = read(`${ext}/sidepanel.js`);
    assert.match(src, /resp\.status === 429[\s\S]{0,80}Rate limited/);
  }
});
