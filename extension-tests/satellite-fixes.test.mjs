import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (ext, f) => readFileSync(new URL(`${ext}-extension/${f}`, root), "utf8");
const BOTH = ["chrome", "firefox"];

function loadFn(src, name) {
  const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
  assert.ok(m, `${name} not found`);
  const ctx = {};
  vm.runInNewContext(`${m[0]}; this.fn = ${name};`, ctx);
  return ctx.fn;
}

for (const ext of BOTH) {
  test(`${ext}: robots parser shares one group across consecutive User-agent lines (#5753)`, () => {
    const parse = loadFn(read(ext, "sidepanel.js"), "parseRobotsTxt");
    const r = parse("User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /private\n\nUser-agent: *\nAllow: /\n");
    const j = (v) => JSON.stringify(v);
    assert.equal(j(r.groups.gptbot.disallow), j(["/private"]));
    assert.equal(j(r.groups.ccbot.disallow), j(["/private"]));
    assert.equal(j(r.groups["*"].disallow), "[]");
  });

  test(`${ext}: score-to-tier is a single canonical function in shared.js (#5773)`, () => {
    const shared = read(ext, "shared.js");
    const side = read(ext, "sidepanel.js");
    assert.match(shared, /function scoreToTier\(/);
    assert.doesNotMatch(side, /function scoreToTier\(/);
    const fn = loadFn(shared, "scoreToTier");
    assert.equal(fn(null), 1);
    assert.equal(fn(61), 3);
    assert.equal(fn(90), 4);
  });

  test(`${ext}: credits are converted from microcents (#6005)`, () => {
    assert.match(read(ext, "sidepanel.js"), /rawCredits \/ 1_000_000/);
  });

  test(`${ext}: side panel tabs carry ARIA roles (#5780)`, () => {
    const html = read(ext, "sidepanel.html");
    assert.match(html, /class="tab-bar" role="tablist"/);
    const tabs = [...html.matchAll(/<button[^>]*\bdata-tab="([a-z]+)"[^>]*>/g)];
    for (const [tag, id] of tabs) {
      assert.match(tag, /role="tab"/);
      assert.ok(tag.includes(`aria-controls="panel-${id}"`));
      assert.match(html, new RegExp(`role="tabpanel" id="panel-${id}"`));
    }
    assert.match(read(ext, "sidepanel.js"), /setAttribute\("aria-selected"/);
  });

  test(`${ext}: scrape polls async jobs and fetch errors keep a status (#5771, #5754)`, () => {
    const bg = read(ext, "background.js");
    assert.match(bg, /_pollJobUntilComplete\(baseUrl, jobId, headers\)/);
    assert.match(bg, /sendResponse\(\{ error: err\.message, body: null, status: 0 \}\)/);
  });

  test(`${ext}: welcome tab opens once and notifications target the side panel (#5757, #5759)`, () => {
    const bg = read(ext, "background.js");
    assert.match(bg, /welcomeTabOpenedInMemory/);
    assert.match(bg, /welcomeTabOpened/);
    assert.match(bg, /target: "sidepanel"/);
  });

  test(`${ext}: test-selector highlights are scroll-stable (#5783)`, () => {
    assert.match(read(ext, "content.js"), /rect\.left \+ window\.scrollX/);
  });
}

test("chrome popup sign-in uses /signin and closes only after the tab exists (#2925, #5758)", () => {
  const js = read("chrome", "popup.js");
  assert.match(js, /\/signin\?source=extension/);
  assert.doesNotMatch(js, /\/login\?source/);
  assert.match(js, /await chrome\.tabs\.create/);
  assert.match(js, /message\.target === "sidepanel"/);
});
