import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

const require = createRequire(import.meta.url);
const P = require("../privacy.js");
const K = require("../connect.js");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

function memStorage(seed = {}) {
  const data = { ...seed };
  return {
    data,
    get: (k, cb) => cb(k == null ? { ...data } : { [k]: data[k] }),
    set: (items, cb) => (Object.assign(data, items), cb()),
    remove: (k, cb) => ([].concat(k).forEach((x) => delete data[x]), cb()),
  };
}

async function makeDeps(storage, over = {}) {
  const pair = await webcrypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const spki = Buffer.from(await webcrypto.subtle.exportKey("spki", pair.publicKey)).toString("base64");
  const pem = `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----`;
  const calls = [];
  return {
    calls,
    getBaseDomain: (h) => h.split(".").slice(-2).join("."),
    confirm: async () => (calls.push(["confirm"]), true),
    hasOrigin: async () => (calls.push(["hasOrigin"]), true),
    removeOrigin: async (p) => (calls.push(["removeOrigin", p]), true),
    getCookies: async (d) => {
      calls.push(["getCookies", d]);
      return { cookies: [{ name: "sid", value: "v", domain: "." + d }], error: null };
    },
    getLocalStorage: async () => ({}),
    getConfig: async () => ({ apiUrl: "https://api.test", apiKey: "k" }),
    fetch: async (url, init) => {
      calls.push(["fetch", init.method, url]);
      const ok = (b) => ({ ok: true, json: async () => b });
      if (url.endsWith("/public-key")) return ok({ available: true, key: pem, version: 1 });
      if (init.method === "POST" && url.endsWith("/api/v1/sessions")) return ok({ session_id: "s1" });
      return ok({});
    },
    crypto: webcrypto,
    storage,
    now: () => 1_000_000,
    ...over,
  };
}

const req = { site: "https://www.example.com", scopes: ["read"], agent: "Bot" };
const uploads = (d) =>
  d.calls.filter((c) => c[0] === "fetch" && ((c[1] === "POST" && c[2].endsWith("/api/v1/sessions")) || c[1] === "PUT"));

test("never-capture site is declined with a reason before prompt, permission or capture", async () => {
  const st = memStorage();
  await P.setSite(st, "example.com", { never: true });
  const d = await makeDeps(st);
  await assert.rejects(K.requestConnect(req, d), (e) => e.code === "SITE_BLOCKED" && /never capture/.test(e.message));
  assert.deepEqual(d.calls, []);
});

test("read-only site declines a write request but allows read", async () => {
  const st = memStorage();
  await P.setSite(st, "example.com", { mode: "read" });
  const d = await makeDeps(st);
  await assert.rejects(K.requestConnect({ ...req, scopes: ["read", "write"] }, d), (e) => e.code === "SITE_READ_ONLY");
  assert.equal((await K.requestConnect(req, d)).ok, true);
});

test("local-only mode: no upload request is ever made", async () => {
  const st = memStorage();
  await P.setGlobal(st, { localOnly: true });
  const d = await makeDeps(st);
  await assert.rejects(K.requestConnect(req, d), (e) => e.code === "LOCAL_ONLY");
  // Manual capture path and raw upload/refresh pushes are blocked too.
  await assert.rejects(K.sealForUpload(d, "example.com", { a: "1" }), (e) => e.code === "LOCAL_ONLY");
  assert.deepEqual(uploads(d), []);
  assert.deepEqual(d.calls.filter((c) => c[0] === "fetch"), []);
});

test("local-only mode blocks refresh pushes of an approved site", async () => {
  const st = memStorage();
  const d = await makeDeps(st);
  await K.requestConnect(req, d);
  d.calls.length = 0;
  await P.setGlobal(st, { localOnly: true });
  d.now = () => 1_000_000 + K.REFRESH_THROTTLE_MS + 1;
  assert.deepEqual(await K.refreshSite("example.com", d), { skipped: "local_only" });
  assert.deepEqual(d.calls.filter((c) => c[0] === "fetch"), []);
});

test("pause declines agent connects and refresh; auto-refresh off skips refresh", async () => {
  const st = memStorage();
  const d = await makeDeps(st);
  await K.requestConnect(req, d);
  d.now = () => 1_000_000 + K.REFRESH_THROTTLE_MS + 1;
  await P.setSite(st, "example.com", { autoRefresh: false });
  assert.deepEqual(await K.refreshSite("example.com", d), { skipped: "auto_refresh_off" });
  await P.setSite(st, "example.com", { autoRefresh: true });
  await P.setGlobal(st, { paused: true });
  assert.deepEqual(await K.refreshSite("example.com", d), { skipped: "paused" });
  await assert.rejects(K.requestConnect(req, d), (e) => e.code === "AGENT_PAUSED");
});

test("defaults leave behaviour unchanged (connect and refresh work)", async () => {
  const st = memStorage();
  const d = await makeDeps(st);
  assert.equal((await K.requestConnect(req, d)).ok, true);
  d.now = () => 1_000_000 + K.REFRESH_THROTTLE_MS + 1;
  assert.deepEqual(await K.refreshSite("example.com", d), { pushed: true });
});

test("settings are normalized and retention only allows 7/30/90/null", async () => {
  const st = memStorage();
  assert.equal((await P.setGlobal(st, { retentionDays: 30 })).retentionDays, 30);
  assert.equal((await P.setGlobal(st, { retentionDays: 5 })).retentionDays, null);
});

test("retention sweep revokes only sites older than the period", async () => {
  const day = 86400000;
  const st = memStorage({
    connectApprovedSites: {
      "old.com": { sessionId: "a", lastPushAt: 0, approvedAt: 0 },
      "new.com": { sessionId: "b", lastPushAt: 99 * day, approvedAt: 0 },
    },
  });
  const revoked = [];
  const deps = { storage: st, now: () => 100 * day, revokeSite: async (d) => revoked.push(d) };
  assert.deepEqual(await P.sweepRetention(deps), { revoked: [] }); // until revoked
  await P.setGlobal(st, { retentionDays: 30 });
  assert.deepEqual((await P.sweepRetention(deps)).revoked, ["old.com"]);
});

test("local inventory lists every category and clear removes its keys", async () => {
  const st = memStorage({ apiKey: "k", alterlabSyncQueue: [1], connectApprovedSites: { a: {} } });
  const inv = await P.inventoryLocal(st);
  assert.deepEqual(inv.map((i) => i.id), P.LOCAL_CATEGORIES.map((c) => c.id));
  assert.equal(inv.find((i) => i.id === "credentials").count, 1);
  await P.clearLocal(st, "queue");
  assert.equal(st.data.alterlabSyncQueue, undefined);
  await assert.rejects(P.clearLocal(st, "sites"), (e) => e.code === "USE_REVOKE");
  await assert.rejects(P.clearLocal(st, "nope"), (e) => e.code === "UNKNOWN_CATEGORY");
});

test("export and delete-all call the privacy endpoints; delete drops local state", async () => {
  const st = memStorage({ connectApprovedSites: { "a.com": {} }, connectKeyShares: { s: "x" } });
  const d = await makeDeps(st);
  await P.exportRemote(d);
  await P.getServerRetention(d);
  await P.deleteAllRemote(d);
  const f = d.calls.filter((c) => c[0] === "fetch").map((c) => `${c[1]} ${c[2]}`);
  assert.deepEqual(f, [
    "GET https://api.test/api/v1/sessions/privacy/export",
    "GET https://api.test/api/v1/sessions/privacy/retention",
    "DELETE https://api.test/api/v1/sessions/privacy/delete-all",
  ]);
  assert.deepEqual(d.calls.filter((c) => c[0] === "removeOrigin"), [["removeOrigin", "*://*.a.com/*"]]);
  assert.equal(st.data.connectApprovedSites, undefined);
  assert.equal(st.data.connectKeyShares, undefined);
});

test("permissions manager lists origins and revokes via permissions.remove", async () => {
  const removed = [];
  const deps = {
    getAllPermissions: async () => ({ origins: ["*://*.b.com/*", "*://*.a.com/*"] }),
    removeOrigin: async (o) => (removed.push(o), true),
  };
  assert.deepEqual(await P.listPermissions(deps), ["*://*.a.com/*", "*://*.b.com/*"]);
  assert.deepEqual(await P.revokePermission("*://*.a.com/*", deps), { origin: "*://*.a.com/*", removed: true });
  assert.deepEqual(removed, ["*://*.a.com/*"]);
});

test("every remote category is listed and the dashboard is wired in both builds", () => {
  assert.deepEqual(P.REMOTE_CATEGORIES.map((c) => c.id), ["sessions", "audit", "reports", "recordings"]);
  for (const b of ["chrome", "firefox"]) {
    const html = read(`../../${b}-extension/sidepanel.html`);
    assert.match(html, /id="privacyPanel"/);
    assert.match(html, /privacy\.js[\s\S]*connect\.js[\s\S]*privacy-panel\.js/);
  }
  assert.match(read("../../firefox-extension/manifest.json"), /"consent\.js", "privacy\.js", "connect\.js"/);
  assert.match(read("../background.js"), /importScripts\([^)]*privacy\.js/);
});

test("chrome and firefox privacy modules are identical", () => {
  for (const f of ["privacy.js", "privacy-panel.js", "connect.js"]) {
    assert.equal(read(`../${f}`), read(`../../firefox-extension/${f}`));
  }
});
