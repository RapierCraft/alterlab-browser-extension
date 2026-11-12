import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const L = require("../localtools.js");
const here = (p) => new URL(p, import.meta.url);
const read = (p) => readFileSync(here(p), "utf8");
const SIGS = JSON.parse(read("../vendor-signatures.json"));
const fixture = (p) => read("./fixtures/" + p);
const scriptsOf = (html) => [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);

// ---- Tool 2: protection detector ------------------------------------------
const VENDOR_CASES = [
  ["cloudflare", [], "cloudflare"],
  ["datadome", ["datadome"], "datadome"],
  ["akamai", ["_abck"], "akamai"],
  ["perimeterx", ["_px3"], "perimeterx"],
  ["kasada", [], "kasada"],
  ["imperva", ["reese84", "visid_incap_123"], "imperva"],
];
for (const [file, cookies, expected] of VENDOR_CASES) {
  test(`protection detector identifies ${expected} fixture`, () => {
    const html = fixture(`vendors/${file}.html`);
    const found = L.detectProtection({ html, scripts: scriptsOf(html), cookies }, SIGS);
    assert.equal(found[0].vendor, expected, JSON.stringify(found));
    assert.ok(found[0].evidence.length > 0);
  });
}

test("protection detector reports nothing on a clean page", () => {
  const html = fixture("pages/pricing.html");
  assert.deepEqual(L.detectProtection({ html, scripts: [], cookies: ["theme"] }, SIGS), []);
});

test("signature JSON covers the 6 vendors and is generated from the registry", () => {
  assert.deepEqual(Object.keys(SIGS.vendors).sort(), ["akamai", "cloudflare", "datadome", "imperva", "kasada", "perimeterx"]);
  assert.equal(readFileSync(here("../../firefox-extension/vendor-signatures.json"), "utf8"), read("../vendor-signatures.json"));
  // The generator reads the platform's vendor registry, which only exists in the
  // monorepo; the public mirror of this extension has the JSON but not the registry.
  const generator = new URL("../../build-vendor-signatures.py", import.meta.url);
  if (existsSync(generator)) {
    execFileSync("python3", ["-I", generator.pathname, "--check"], { stdio: "pipe" });
  }
});

// ---- Tool 3: markdown -------------------------------------------------------
const PAGES = ["article", "pricing", "products", "docs", "news"];

test("markdown on the article fixture", () => {
  const md = L.toMarkdown(fixture("pages/article.html"));
  assert.match(md, /^# Scraping Guide/);
  assert.match(md, /\*\*stealth\*\* and \*patience\*/);
  assert.match(md, /\[the docs\]\(https:\/\/example\.com\/docs\)/);
  assert.match(md, /^## Steps$/m);
  assert.match(md, /^1\. Fetch$/m);
  assert.match(md, /^- Fast\n {2}- Cached$/m);
  assert.match(md, /```\ncurl https:\/\/x\.test\n```/);
  assert.match(md, /^> Quoted & true$/m);
  assert.ok(!md.includes("Footer junk") && !md.includes("tracking") && !md.includes("Home"));
});

test("markdown works on all 5 fixture pages", () => {
  for (const p of PAGES) {
    const md = L.toMarkdown(fixture(`pages/${p}.html`));
    assert.ok(md.length > 10, p);
    assert.ok(!/<\/?(div|table|td|script)/.test(md), p);
  }
  assert.match(L.toMarkdown(fixture("pages/pricing.html")), /\| Plan \| Price \|\n\| --- \| --- \|\n\| Free \| \$0 \|/);
  const docs = L.toMarkdown(fixture("pages/docs.html"));
  assert.match(docs, /Para one\n\nPara two \(unclosed\)/);
  assert.match(docs, /b \\\| c/);
});

// ---- Tool 5: tables and lists -----------------------------------------------
test("table to CSV/JSON works on all 5 fixture pages", () => {
  const expected = { article: 1, pricing: 1, products: 2, docs: 1, news: 1 };
  for (const p of PAGES) {
    const tables = L.extractTables(fixture(`pages/${p}.html`));
    assert.equal(tables.length, expected[p], p);
    for (const t of tables) {
      const csv = L.toCsv(t);
      assert.ok(csv.endsWith("\r\n"));
      assert.equal(L.toJson(t).length, t.rows.length);
    }
  }
});

test("CSV quoting and JSON keys", () => {
  const [t] = L.extractTables(fixture("pages/pricing.html"));
  assert.equal(t.name, "Plan prices");
  assert.equal(L.toCsv(t), 'Plan,Price\r\nFree,$0\r\n"Pro, annual","$""99"""\r\nTeam,$299\r\n');
  assert.deepEqual(L.toJson(t)[0], { Plan: "Free", Price: "$0" });
  const list = L.extractTables(fixture("pages/products.html")).find((x) => x.kind === "list");
  assert.deepEqual(list.rows, [["Widget A"], ["Widget B"], ["Widget C"]]);
});

// ---- Tool 4: structured data ------------------------------------------------
test("structured data viewer reads JSON-LD, OpenGraph, meta and hints", () => {
  const d = L.extractStructuredData(fixture("pages/news.html"));
  assert.equal(d.jsonLd.length, 1);
  assert.deepEqual(d.schemaTypes, ["NewsArticle"]);
  assert.equal(d.openGraph.title, "Daily News");
  assert.equal(d.meta.description, "All the news");
  assert.ok(d.hints.some((h) => h.startsWith("Invalid JSON-LD")));
  assert.ok(d.hints.includes("Missing og:image"));
  assert.ok(d.hints.includes("Missing canonical link"));
  const none = L.extractStructuredData(fixture("pages/docs.html"));
  assert.ok(none.hints.includes("No schema.org structured data found"));
});

// ---- Tool 1: trackers -------------------------------------------------------
test("tracker audit groups by company and scores privacy", () => {
  const html = '<script src="https://www.googletagmanager.com/gtm.js"></script><script src="https://www.google-analytics.com/analytics.js"></script><img src="https://www.facebook.com/tr?id=1"><script src="/app.js"></script>';
  const a = L.auditTrackers({ url: "https://shop.example.com/", html, scripts: scriptsOf(html), cookies: ["_ga", "_fbp", "session"], resources: [{ url: "https://static.hotjar.com/c/hotjar.js", type: "script" }] });
  const names = a.companies.map((c) => c.company).sort();
  assert.deepEqual(names, ["Google", "Hotjar", "Meta"]);
  assert.deepEqual(a.companies.find((c) => c.company === "Google").hosts.sort(), ["www.google-analytics.com", "www.googletagmanager.com"]);
  assert.equal(a.cookieCount, 2);
  assert.ok(a.score < 100 && a.score >= 0);
  const clean = L.auditTrackers({ url: "https://example.com/", html: '<script src="/a.js"></script>', scripts: ["https://cdn.example.com/a.js"], cookies: ["session"] });
  assert.equal(clean.score, 100);
});

// ---- Tool 6: endpoints ------------------------------------------------------
test("endpoint inspector keeps JSON-like XHR/fetch calls grouped by path", () => {
  const e = L.summarizeEndpoints(
    [
      { url: "https://example.com/api/items?page=1", type: "fetch" },
      { url: "https://example.com/api/items?page=2", type: "fetch" },
      { url: "https://other.net/v1/data", type: "xmlhttprequest" },
      { url: "https://example.com/logo.png", type: "img" },
      { url: "https://example.com/style.css", type: "fetch" },
    ],
    "https://www.example.com/",
  );
  assert.equal(e.length, 2);
  assert.equal(e[0].endpoint, "https://example.com/api/items");
  assert.equal(e[0].count, 2);
  assert.equal(e[0].sameSite, true);
  assert.equal(e[1].sameSite, false);
});

// ---- Tool 7: AI readiness ---------------------------------------------------
test("AI readiness parses robots.txt crawler rules and llms.txt", () => {
  const robots = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nUser-agent: CCBot\nDisallow: /private\n\nUser-agent: *\nAllow: /\nSitemap: https://x.test/s.xml\n";
  const r = L.parseAiReadiness(robots, "# Site\n> summary\n");
  const by = Object.fromEntries(r.crawlers.map((c) => [c.name, c.status]));
  assert.equal(by.GPTBot, "blocked");
  assert.equal(by.ClaudeBot, "partial");
  assert.equal(by.CCBot, "partial");
  assert.equal(by.PerplexityBot, "allowed");
  assert.equal(r.llmsTxt.present, true);
  assert.equal(r.sitemaps, 1);
  const none = L.parseAiReadiness("", "<!doctype html><html>");
  assert.equal(none.llmsTxt.present, false);
  assert.ok(none.hints.length >= 2);
});

// ---- Network / permission guarantees -----------------------------------------
test("localtools.js performs no network I/O and chrome/firefox copies are identical", () => {
  const src = read("../localtools.js");
  assert.ok(!/\bfetch\s*\(|new XMLHttpRequest|sendBeacon|WebSocket|importScripts|alterlab\.io|\/api\/v1/i.test(src));
  assert.equal(src, readFileSync(here("../../firefox-extension/localtools.js"), "utf8"));
});

for (const target of ["chrome", "firefox"]) {
  const dir = `../../${target}-extension/`;
  test(`${target} tools region makes no AlterLab call; only the labelled check does`, () => {
    const panel = readFileSync(here(dir + "sidepanel.js"), "utf8");
    const local = panel.split("// LOCAL-TOOLS-BEGIN")[1].split("// LOCAL-TOOLS-END")[0];
    const check = panel.split("// LOCAL-TOOLS-CHECK-BEGIN")[1].split("// LOCAL-TOOLS-CHECK-END")[0];
    assert.ok(!/\/api\/v1|apiUrl|loadConfig|X-API-Key/.test(local));
    assert.deepEqual(local.match(/\bfetch\s*\([^)]*\)/g), ["fetch(chrome.runtime.getURL(\"vendor-signatures.json\")"]);
    assert.match(check, /\/api\/v1\/scrape/);
    const html = readFileSync(here(dir + "sidepanel.html"), "utf8");
    assert.match(html, /trial quota/i);
    assert.match(html, /<script src="localtools\.js">/);
  });

  test(`${target} manifest gains no permissions and background gains no listeners`, () => {
    const m = JSON.parse(readFileSync(here(dir + "manifest.json"), "utf8"));
    assert.equal(m.host_permissions, undefined);
    assert.ok(!m.permissions.includes("webRequest"));
    assert.deepEqual(m.optional_permissions, ["webRequest"]);
    assert.ok(!/LOCAL_TOOLS/.test(readFileSync(here(dir + "background.js"), "utf8")));
    assert.match(readFileSync(here(dir + "content.js"), "utf8"), /LOCAL_TOOLS_SNAPSHOT/);
  });
}
