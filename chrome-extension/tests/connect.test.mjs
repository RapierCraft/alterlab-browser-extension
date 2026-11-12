import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

const require = createRequire(import.meta.url);
const K = require("../connect.js");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

function memStorage() {
  const data = {};
  return {
    data,
    get: (k, cb) => cb({ [k]: data[k] }),
    set: (items, cb) => (Object.assign(data, items), cb()),
  };
}

async function makeDeps(over = {}) {
  const pair = await webcrypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const spki = Buffer.from(await webcrypto.subtle.exportKey("spki", pair.publicKey)).toString("base64");
  const pem = `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----`;
  const calls = [];
  const deps = {
    calls,
    getBaseDomain: (h) => h.split(".").slice(-2).join("."),
    confirm: async () => true,
    hasOrigin: async () => true,
    removeOrigin: async (p) => calls.push(["removeOrigin", p]),
    getCookies: async (d) => {
      calls.push(["getCookies", d]);
      return { cookies: [{ name: "sid", value: "SECRET-COOKIE-VALUE", domain: "." + d }], error: null };
    },
    getLocalStorage: async () => ({}),
    getConfig: async () => ({ apiUrl: "https://api.test", apiKey: "k" }),
    fetch: async (url, init) => {
      calls.push(["fetch", init.method, url, init.body]);
      const ok = (b) => ({ ok: true, json: async () => b });
      if (url.endsWith("/public-key")) return ok({ available: true, key: pem, version: 1 });
      if (init.method === "POST" && url.endsWith("/api/v1/sessions")) return ok({ session_id: "s1" });
      return ok({});
    },
    crypto: webcrypto,
    storage: memStorage(),
    now: () => 1_000_000,
    ...over,
  };
  return deps;
}

const req = { site: "https://www.example.com", scopes: ["read"], agent: "Bot" };
const bodies = (d) => d.calls.filter((c) => c[0] === "fetch").map((c) => c[3]).join("\n");

test("no capture or upload before approval", async () => {
  const d = await makeDeps({ confirm: async () => false });
  await assert.rejects(() => K.requestConnect(req, d), { code: "CONSENT_DENIED" });
  assert.equal(d.calls.length, 0);
});

test("no capture without the site permission", async () => {
  const d = await makeDeps({ hasOrigin: async () => false });
  await assert.rejects(() => K.requestConnect(req, d), { code: "PERMISSION_DENIED" });
  assert.equal(d.calls.length, 0);
});

test("only the consented site is captured and the body is sealed", async () => {
  const d = await makeDeps();
  const res = await K.requestConnect(req, d);
  assert.equal(res.session_id, "s1");
  assert.deepEqual(d.calls.filter((c) => c[0] === "getCookies"), [["getCookies", "example.com"]]);
  const post = d.calls.find((c) => c[1] === "POST");
  const body = JSON.parse(post[3]);
  assert.equal(body.encryption_mode, "client");
  assert.equal(body.consent, true);
  assert.ok(body.encrypted_cookies && body.wrapped_key);
  assert.ok(!bodies(d).includes("SECRET-COOKIE-VALUE"));
  assert.ok(K.originPattern("example.com").includes("example.com"));
});

test("refresh is throttled and limited to approved sites", async () => {
  let t = 1_000_000;
  const d = await makeDeps({ now: () => t });
  await K.requestConnect(req, d);
  assert.deepEqual(await K.refreshSite("other.com", d), { skipped: "not_approved" });
  assert.deepEqual(await K.refreshSite("example.com", d), { skipped: "throttled" });
  assert.equal((await K.getApproved(d.storage))["example.com"].pending, true);
  t += K.REFRESH_THROTTLE_MS + 1;
  assert.deepEqual(await K.refreshSite("example.com", d), { pushed: true });
  const put = d.calls.find((c) => c[1] === "PUT");
  assert.ok(put[2].endsWith("/s1/sealed"));
  assert.ok(!put[3].includes("SECRET-COOKIE-VALUE"));
});

test("revoke deactivates, deletes, drops key share and permission", async () => {
  const d = await makeDeps();
  await K.requestConnect({ ...req, accessMode: "per_use" }, d);
  assert.ok(await K.getKeyShare(d.storage, "s1"));
  assert.deepEqual(await K.revokeSite("example.com", d), { revoked: true });
  const f = d.calls.filter((c) => c[0] === "fetch").map((c) => `${c[1]} ${c[2]}`);
  assert.ok(f.includes("POST https://api.test/api/v1/sessions/s1/deactivate"));
  assert.ok(f.includes("DELETE https://api.test/api/v1/sessions/s1"));
  assert.equal(await K.getKeyShare(d.storage, "s1"), null);
  assert.ok(d.calls.some((c) => c[0] === "removeOrigin"));
  assert.deepEqual(await K.listConnected(d.storage), []);
});

test("manifests request no all_urls host permission", () => {
  for (const p of ["../manifest.json", "../../firefox-extension/manifest.json"]) {
    const m = JSON.parse(read(p));
    for (const key of ["host_permissions", "optional_host_permissions", "permissions", "optional_permissions"]) {
      assert.ok(!(m[key] || []).includes("<all_urls>"), `${p} ${key}`);
    }
    assert.equal(m.host_permissions, undefined, `${p} required host_permissions`);
    // Ceiling so runtime permissions.request for a single origin is allowed.
    assert.deepEqual(m.optional_host_permissions, ["https://*/*", "http://*/*"], p);
  }
});

test("chrome and firefox shared modules are identical", () => {
  for (const f of ["connect.js", "consent.js", "confirm.js", "activity.js"]) {
    assert.equal(read(`../${f}`), read(`../../firefox-extension/${f}`), f);
  }
});

test("fetchActivity reads the Hands action audit, capped at 50, with agent by session", async () => {
  const storage = memStorage();
  storage.data[K.APPROVED_KEY] = { "example.com": { sessionId: "s1", agent: "Claude", scopes: ["read"] } };
  const entries = Array.from({ length: 60 }, (_, i) => ({
    id: i,
    task_id: `t${i}`,
    session_id: i === 0 ? "s1" : null,
    site: "other.org",
    action_type: "click",
    outcome: "ok",
    created_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
  }));
  const urls = [];
  const deps = {
    storage,
    getConfig: async () => ({ apiUrl: "https://api.test", apiKey: "k" }),
    fetch: async (u) => (urls.push(u), { ok: true, json: async () => ({ entries }) }),
  };
  const rows = await K.fetchActivity(deps);
  assert.deepEqual(urls, ["https://api.test/api/v1/hands/audit?limit=50"]);
  assert.equal(rows.length, 50);
  assert.equal(rows[0].at, "2026-01-01T00:00:59Z");
  assert.equal(rows[0].domain, "other.org");
  assert.equal(rows[0].action, "click");
  const mine = (await K.fetchActivity({ ...deps, fetch: async () => ({ ok: true, json: async () => ({ entries: entries.slice(0, 1) }) }) }))[0];
  assert.equal(mine.agent, "Claude");
  assert.equal(mine.domain, "example.com");
  assert.equal(mine.task, "t0");
});

test("fetchActivity falls back to decrypt-audit when the action audit fails", async () => {
  const storage = memStorage();
  storage.data[K.APPROVED_KEY] = { "example.com": { sessionId: "s1", agent: "Claude", scopes: ["read"] } };
  const deps = {
    storage,
    getConfig: async () => ({ apiUrl: "https://api.test", apiKey: "k" }),
    fetch: async (u) =>
      u.includes("/hands/audit")
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, json: async () => [{ job_id: "j1", mode: "scrape", outcome: "ok", created_at: "2026-01-01T00:00:00Z" }] },
  };
  const rows = await K.fetchActivity(deps);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task, "j1");
  assert.equal(rows[0].agent, "Claude");
});
