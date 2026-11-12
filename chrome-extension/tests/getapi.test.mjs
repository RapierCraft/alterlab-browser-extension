import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const G = require("../getapi.js");
const rd = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const r = routes[path];
    return { ok: r.status === undefined || r.status < 400, status: r.status || 200, json: async () => r.body };
  };
}

test("chrome and firefox getapi.js are identical", () => {
  assert.equal(rd("../getapi.js"), rd("../../firefox-extension/getapi.js"));
});

test("snippets cover curl, python, node and mcp", () => {
  const s = G.buildSnippets("https://example.com/a?b='c", "k1");
  assert.match(s.curl, /curl -X POST .*\/api\/v1\/scrape/);
  assert.match(s.python, /requests\.post/);
  assert.match(s.node, /await fetch/);
  assert.match(s.mcp, /mcp\.alterlab\.io\/mcp/);
  assert.match(s.curl, /X-API-Key: k1/);
});

test("keyless run obtains a trial key then returns typed JSON", async () => {
  const calls = [];
  const f = fakeFetch(
    {
      "/api/v1/agent/trial": { body: { key: "sk_trial_x" } },
      "/api/v1/scrape": { body: { job_id: "j1", content: { title: "T" } } },
    },
    calls,
  );
  const r = await G.runGetApi(f, { url: "https://example.com" });
  assert.equal(r.error, null);
  assert.equal(r.jobId, "j1");
  assert.equal(r.apiKey, "sk_trial_x");
  assert.equal(calls[1].init.headers["X-API-Key"], "sk_trial_x");
  assert.deepEqual(JSON.parse(calls[1].init.body).formats, ["json"]);
  assert.equal(r.publish.ok, true);
});

test("publish refused for login-required and PII results without calling the API", async () => {
  const calls = [];
  const f = fakeFetch({}, calls);
  const login = { jobId: "j", content: "Please sign in to continue" };
  const pii = { jobId: "j", content: { rows: [{ email: "a@b.c" }] } };
  for (const [run, code] of [[login, "authenticated_result"], [pii, "pii_flagged"]]) {
    const r = await G.publishPage(f, { apiKey: "k", run, title: "t" });
    assert.equal(r.error.code, code);
  }
  assert.equal(calls.length, 0);
});

test("publish posts job id and surfaces server refusal", async () => {
  const ok = await G.publishPage(
    fakeFetch({ "/api/v1/public-pages": { body: { url: "https://alterlab.io/d/x" } } }),
    { apiKey: "k", run: { jobId: "j", content: { a: 1 } }, title: "t" },
  );
  assert.equal(ok.page.url, "https://alterlab.io/d/x");
  const refused = await G.publishPage(
    fakeFetch({ "/api/v1/public-pages": { status: 422, body: { detail: { code: "pii_flagged", message: "m" } } } }),
    { apiKey: "k", run: { jobId: "j", content: { a: 1 } }, title: "t" },
  );
  assert.equal(refused.error.code, "pii_flagged");
});

test("schedule posts a cron schedule", async () => {
  const calls = [];
  const r = await G.schedulePage(fakeFetch({ "/api/v1/schedules": { body: { id: "s" } } }, calls), {
    apiKey: "k",
    url: "https://example.com",
  });
  assert.equal(r.error, null);
  assert.deepEqual(JSON.parse(calls[0].init.body).urls, ["https://example.com"]);
});

test("manifest permissions are unchanged from the base", () => {
  for (const b of ["chrome", "firefox"]) {
    const path = `tools/${b}-extension/manifest.json`;
    const now = JSON.parse(rd(`../../${b}-extension/manifest.json`));
    let base;
    try {
      base = JSON.parse(execFileSync("git", ["show", `origin/milestone/alterlab-hands:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      base = now; // base ref unavailable offline
    }
    // "notifications" is the one addition: Hands approval prompts (#38937).
    assert.deepEqual(now.permissions.filter((x) => x !== "notifications"), base.permissions.filter((x) => x !== "notifications"));
    assert.deepEqual(now.optional_host_permissions, base.optional_host_permissions);
    assert.ok(now.permissions.includes("activeTab"));
    assert.ok(!JSON.stringify(now).includes("<all_urls>"));
  }
});
