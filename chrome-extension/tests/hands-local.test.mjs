import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const H = require("../hands-local.js");

const task = { id: "t1", start_url: "https://example.com/", domains: ["example.com"] };

function makeDeps(steps, calls = [], over = {}) {
  const queue = [...steps];
  const state = { badge: [], closed: [], banners: [] };
  const deps = {
    baseUrl: "https://api.test",
    running: new Map(),
    newAbort: () => new AbortController(),
    setBadge: (t) => state.badge.push(t),
    openTab: async () => 7,
    closeTab: async (id) => state.closed.push(id),
    getTab: async () => ({ url: "https://example.com/page" }),
    settle: async () => {},
    navigate: async () => {},
    executeScript: async (tabId, func, args) => {
      if (func.name === "pageBanner") state.banners.push(args[2]);
      if (func.name === "pageAction") return [{ result: { ok: true } }];
      if (func.name === "pageObserve") return [{ result: { url: "https://example.com/page", title: "t", text: "hi" } }];
      return [{ result: undefined }];
    },
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/local/next")) {
        const step = queue.shift();
        return { ok: true, json: async () => ({ step: step || { op: "close" } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
    ...over,
  };
  return { deps, state };
}

test("chrome and firefox modules are identical", () => {
  assert.equal(
    readFileSync(new URL("../hands-local.js", import.meta.url), "utf8"),
    readFileSync(new URL("../../firefox-extension/hands-local.js", import.meta.url), "utf8"),
  );
});

test("read task: only alterlab hands endpoints are called and no session data is sent", async () => {
  const calls = [];
  const { deps, state } = makeDeps(
    [{ op: "act", step_id: "s1", actions: [{ type: "scroll_into_view", selector: "#a" }] }, { op: "observe", step_id: "s2" }],
    calls,
  );
  await H.runTask(deps, task);
  assert.ok(calls.length >= 3);
  for (const c of calls) {
    assert.ok(c.url.startsWith("https://api.test/api/v1/hands/tasks/t1/local/"), c.url);
    const body = String(c.init.body || "").toLowerCase();
    assert.ok(!/cookie|storage_state|localstorage|set-cookie/.test(body), body);
  }
  assert.deepEqual(state.badge, ["AI", ""]);
  assert.deepEqual(state.closed, [7]);
  assert.equal(deps.running.size, 0);
});

test("banner with stop is shown while running and wired to the stop message", async () => {
  const { deps, state } = makeDeps([{ op: "act", step_id: "s1", actions: [{ type: "wait", milliseconds: 1 }] }]);
  await H.runTask(deps, task);
  assert.ok(state.banners.includes(true));
  assert.equal(H.STOP_MESSAGE, "alterlab-hands-local-stop");
  const src = readFileSync(new URL("../hands-local.js", import.meta.url), "utf8");
  assert.match(src, /sendMessage\(\{ type: stopMessage, taskId \}\)/);
});

test("navigate outside the task domain set is refused", async () => {
  const { deps } = makeDeps([]);
  const ctx = { task, tabId: 7, stopped: false };
  const out = await H.runAction(deps, ctx, { type: "navigate", url: "https://evil.test/" });
  assert.equal(out.error, "domain_not_allowed");
});

test("vault-backed actions are unsupported locally", async () => {
  const { deps } = makeDeps([]);
  const out = await H.runAction(deps, { task, tabId: 7 }, { type: "fill_secret", selector: "#p", secret: "X" });
  assert.equal(out.error, "unsupported_in_local_mode");
});

test("stop aborts the in-flight poll instantly, closes the tab and tells the API", async () => {
  const calls = [];
  let aborted = false;
  const { deps, state } = makeDeps([], calls, {
    newAbort: () => {
      const ac = new AbortController();
      ac.signal.addEventListener("abort", () => (aborted = true));
      return ac;
    },
  });
  const origFetch = deps.fetch;
  deps.fetch = (url, init = {}) => {
    if (url.endsWith("/local/next")) {
      calls.push({ url, init });
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return origFetch(url, init);
  };
  const run = H.runTask(deps, task);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await H.stopTask(deps, "t1"), true);
  await run;
  assert.ok(aborted);
  assert.deepEqual(state.closed, [7]);
  assert.ok(calls.some((c) => c.url.endsWith("/local/stop") && c.init.method === "POST"));
  assert.equal(deps.running.size, 0);
});
