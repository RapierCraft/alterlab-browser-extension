import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const B = require("../byos-refresh.js");
const C = require("../consent.js");

function memStorage() {
  const data = {};
  return {
    data,
    get: (k, cb) => cb({ [k]: data[k] }),
    set: (items, cb) => (Object.assign(data, items), cb && cb()),
    remove: (k, cb) => (delete data[k], cb()),
  };
}

test("chrome and firefox byos-refresh modules are identical", () => {
  assert.equal(
    readFileSync(new URL("../byos-refresh.js", import.meta.url), "utf8"),
    readFileSync(
      new URL("../../firefox-extension/byos-refresh.js", import.meta.url),
      "utf8",
    ),
  );
});

test("domain map only tracks sessions; matching covers parent and subdomain cookies", () => {
  const map = B.buildDomainMap({
    sessions: [{ id: "s1", domain: "Amazon.com" }, { id: "s2" }],
  });
  assert.deepEqual(map, { "amazon.com": "s1" });
  assert.deepEqual(B.findTracked(map, ".amazon.com"), {
    domain: "amazon.com",
    sessionId: "s1",
  });
  assert.deepEqual(B.findTracked(map, "www.amazon.com")?.sessionId, "s1");
  assert.equal(B.findTracked(map, "evil-amazon.com"), null);
  assert.equal(B.findTracked(map, "example.org"), null);
});

test("bar only appears with granted permission; auto mode skips the bar", () => {
  const d = B.decideBackgroundAction;
  assert.equal(
    d({ permitted: false, autoRefresh: true, consented: true }),
    "ignore",
  );
  assert.equal(
    d({ permitted: true, autoRefresh: false, consented: true }),
    "notify",
  );
  assert.equal(
    d({ permitted: true, autoRefresh: true, consented: true }),
    "auto",
  );
  assert.equal(
    d({ permitted: true, autoRefresh: true, consented: false }),
    "notify",
  );
});

test("dismissal is per domain and in memory; auto mode never queues the bar", () => {
  const s = B.createBarState();
  assert.equal(s.add("a.com", "1", false), true);
  assert.equal(s.add("b.com", "2", false), true);
  s.dismiss("a.com");
  assert.equal(s.add("a.com", "1", false), false);
  assert.deepEqual(s.next(), { domain: "b.com", sessionId: "2" });
  assert.equal(s.add("c.com", "3", true), false);
});

test("no PATCH body without consent; body carries only the tracked domain's cookies", async () => {
  const store = memStorage();
  const cookies = [
    { name: "a", value: "1", domain: ".amazon.com" },
    { name: "b", value: "2", domain: "other.com" },
  ];
  await assert.rejects(
    () => B.buildPatchBody(C, store, cookies, "amazon.com"),
    {
      code: "CONSENT_NOT_GRANTED",
    },
  );
  await C.grantConsent(store);
  assert.deepEqual(await B.buildPatchBody(C, store, cookies, "amazon.com"), {
    cookies: { a: "1" },
  });
  await assert.rejects(() => B.buildPatchBody(C, store, [], "amazon.com"), {
    code: "NO_COOKIES",
  });
});

test("debouncer coalesces rapid changes per key", () => {
  const timers = [];
  const d = B.createDebouncer(10, {
    set: (fn) => (timers.push({ fn, live: true }), timers.length - 1),
    clear: (i) => (timers[i].live = false),
  });
  let n = 0;
  d("a", () => n++);
  d("a", () => n++);
  d("b", () => n++);
  timers.filter((t) => t.live).forEach((t) => t.fn());
  assert.equal(n, 2);
});

function fakeChrome({ permitted, autoRefresh, consent }) {
  const listeners = {};
  const local = { ...(autoRefresh ? { [B.AUTO_REFRESH_KEY]: true } : {}) };
  const sent = [];
  const chrome = {
    cookies: {
      onChanged: { addListener: (f) => (listeners.cookie = f) },
      getAll: async () => [{ name: "sid", value: "v", domain: ".amazon.com" }],
    },
    alarms: {
      get: async () => ({}),
      create() {},
      onAlarm: { addListener() {} },
    },
    permissions: { contains: async () => permitted },
    runtime: { onMessage: { addListener: (f) => (listeners.msg = f) } },
    storage: {
      session: { get: async () => ({}), set: async () => {} },
      local: {
        get: async (k) =>
          Object.fromEntries([].concat(k).map((n) => [n, local[n]])),
        _raw: { get: (k, cb) => cb({ [k]: local[k] }) },
      },
    },
  };
  const consentApi = { hasConsent: async () => consent };
  return { chrome, listeners, sent, consentApi };
}

async function run(opts) {
  const f = fakeChrome(opts);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    return { ok: true, json: async () => [{ id: "s1", domain: "amazon.com" }] };
  };
  const notes = [];
  try {
    B.startMonitor({
      chrome: f.chrome,
      loadConfig: async () => ({ apiKey: "k", apiUrl: "https://x.test" }),
      getBaseDomain: (h) => h,
      notify: (m) => notes.push(m),
      consent: f.consentApi,
    });
    f.listeners.cookie({ cookie: { domain: ".amazon.com", name: "sid" } });
    await new Promise((r) => setTimeout(r, 30));
    await new Promise((r) => setTimeout(r, B.DEBOUNCE_MS + 100));
  } finally {
    globalThis.fetch = realFetch;
  }
  return { calls, notes };
}

test("monitor: permission granted + toggle off notifies and sends nothing", async () => {
  const { calls, notes } = await run({
    permitted: true,
    autoRefresh: false,
    consent: true,
  });
  assert.equal(notes[0]?.type, "BYOS_COOKIE_CHANGED");
  assert.equal(notes[0].sessionId, "s1");
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
});

test("monitor: no host permission means no event and no PATCH", async () => {
  const { calls, notes } = await run({
    permitted: false,
    autoRefresh: true,
    consent: true,
  });
  assert.equal(notes.length, 0);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
});

test("monitor: auto mode with consent PATCHes without a bar event", async () => {
  const { calls, notes } = await run({
    permitted: true,
    autoRefresh: true,
    consent: true,
  });
  assert.equal(notes.length, 0);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
  assert.match(
    calls.find((c) => c.method === "PATCH").url,
    /\/api\/v1\/sessions\/s1$/,
  );
});
