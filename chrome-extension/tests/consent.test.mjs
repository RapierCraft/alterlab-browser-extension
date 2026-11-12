import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const C = require("../consent.js");
const F = require("../../firefox-extension/consent.js");

function memStorage() {
  const data = {};
  return {
    data,
    get: (k, cb) => cb({ [k]: data[k] }),
    set: (items, cb) => (Object.assign(data, items), cb()),
    remove: (k, cb) => (delete data[k], cb()),
  };
}

const fields = { domain: "example.com", name: "s", cookies: { a: "1" } };

test("chrome and firefox consent modules are identical", () => {
  assert.equal(
    readFileSync(new URL("../consent.js", import.meta.url), "utf8"),
    readFileSync(new URL("../../firefox-extension/consent.js", import.meta.url), "utf8"),
  );
  assert.equal(typeof F.buildSessionBody, "function");
});

test("no upload body before consent", async () => {
  const s = memStorage();
  await assert.rejects(() => C.buildSessionBody(s, fields), { code: "CONSENT_NOT_GRANTED" });
});

test("consent record is timestamped and enables consent:true body", async () => {
  const s = memStorage();
  const rec = await C.grantConsent(s, Date.UTC(2026, 0, 2));
  assert.equal(rec.grantedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(s.data[C.CONSENT_STORAGE_KEY].version, C.CONSENT_VERSION);
  const body = await C.buildSessionBody(s, fields);
  assert.equal(body.consent, true);
  assert.deepEqual(body.cookies, { a: "1" });
});

test("revoke clears consent and blocks upload again", async () => {
  const s = memStorage();
  await C.grantConsent(s);
  await C.revokeConsent(s);
  assert.equal(await C.hasConsent(s), false);
  await assert.rejects(() => C.buildSessionBody(s, fields), { code: "CONSENT_NOT_GRANTED" });
});

const base = (h) => h.split(".").slice(-2).join(".");
const cookies = [
  { name: "a", domain: ".example.com" },
  { name: "b", domain: "sub.example.com" },
  { name: "c", domain: "other.com" },
];

test("bridge without confirmation returns an error and no cookies", async () => {
  let fetched = false;
  const r = await C.captureForDashboard("www.example.com", {
    getBaseDomain: base,
    confirm: async () => false,
    getCookies: async () => ((fetched = true), { cookies, error: null }),
  });
  assert.ok(r.error);
  assert.deepEqual(r.cookies, []);
  assert.equal(fetched, false);
});

test("bridge confirm failure counts as denial", async () => {
  const r = await C.captureForDashboard("example.com", {
    getBaseDomain: base,
    confirm: async () => {
      throw new Error("closed");
    },
    getCookies: async () => ({ cookies, error: null }),
  });
  assert.ok(r.error);
});

test("confirmed bridge is limited to the confirmed domain", async () => {
  let asked;
  const r = await C.captureForDashboard("www.example.com", {
    getBaseDomain: base,
    confirm: async (d) => ((asked = d), true),
    getCookies: async () => ({ cookies, error: null }),
  });
  assert.equal(asked, "example.com");
  assert.equal(r.error, null);
  assert.deepEqual(r.cookies.map((c) => c.name), ["a", "b"]);
});

test("bridge rejects invalid domain", async () => {
  const r = await C.captureForDashboard(42, { getBaseDomain: base });
  assert.equal(r.error, "Invalid domain");
});

test("upload body carries capture_context from navigator and Intl", async () => {
  const s = memStorage();
  await C.grantConsent(s);
  const body = await C.buildSessionBody(s, fields);
  const cc = body.capture_context;
  assert.deepEqual(Object.keys(cc).sort(), [
    "languages",
    "locale",
    "platform",
    "timezone",
    "user_agent",
  ]);
  assert.equal(cc.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(cc.user_agent, globalThis.navigator ? navigator.userAgent : "");
  assert.equal(cc.locale, globalThis.navigator ? navigator.language : "");
});

test("an explicit captureContext field wins", async () => {
  const s = memStorage();
  await C.grantConsent(s);
  const ctx = { user_agent: "UA", platform: "P", locale: "de-DE", timezone: "Europe/Berlin" };
  const body = await C.buildSessionBody(s, { ...fields, captureContext: ctx });
  assert.deepEqual(body.capture_context, ctx);
});
