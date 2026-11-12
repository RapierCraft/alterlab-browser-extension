import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (t, f) => readFileSync(path.join(root, `${t}-extension`, f), "utf8");

for (const target of ["chrome", "firefox"]) {
  test(`${target} manifest requests narrow permissions`, () => {
    const m = JSON.parse(read(target, "manifest.json"));
    assert.equal(m.host_permissions, undefined);
    assert.equal(m.content_scripts, undefined);
    assert.ok(!m.permissions.includes("webRequest"));
    assert.deepEqual(m.optional_permissions, ["webRequest"]);
    assert.deepEqual(m.optional_host_permissions, ["https://*/*", "http://*/*"]);
    assert.ok(m.permissions.includes("activeTab"));
  });

  test(`${target} background has no automatic analysis or domain score persistence`, () => {
    const bg = read(target, "background.js");
    assert.ok(!bg.includes("requestAnalysisWithRetry"));
    assert.ok(!bg.includes("CONTENT_SCRIPT_READY"));
    assert.ok(!/storage\.local\.set\([^)]*scrapeScore_/.test(bg));
    assert.ok(!/chrome\.webRequest\.on\w+\.addListener/.test(bg));
    assert.ok(!read(target, "content.js").includes("CONTENT_SCRIPT_READY"));
  });
}

function loadShared(target, store) {
  const local = {
    get: (keys, cb) => {
      const out = {};
      if (keys === null) Object.assign(out, store);
      else for (const k of keys) if (k in store) out[k] = store[k];
      cb(out);
    },
    set: (obj, cb) => {
      for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v);
      cb && cb();
    },
    remove: (keys, cb) => {
      for (const k of keys) delete store[k];
      cb && cb();
    },
  };
  const ctx = vm.createContext({
    chrome: { storage: { local } },
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    structuredClone,
    console,
  });
  vm.runInContext(read(target, "shared.js"), ctx);
  let key = null;
  ctx._idbGetKey = async () => key;
  ctx._idbPutKey = async (k) => {
    key = k;
  };
  return ctx;
}

const cookie = { name: "sid", value: "SECRET-VALUE", domain: "example.com", path: "/" };

for (const target of ["chrome", "firefox"]) {
  test(`${target} profiles are encrypted at rest and round-trip`, async () => {
    const store = {};
    const ctx = loadShared(target, store);
    await ctx.saveSessionProfile({ name: "a", domain: "example.com", cookies: [cookie] });
    const raw = JSON.stringify(store.alterlabSessionProfiles);
    assert.ok(!raw.includes("SECRET-VALUE"));
    assert.equal(store.alterlabSessionProfiles[0].cookies, undefined);
    const [p] = await ctx.getAllSessionProfiles();
    assert.equal(p.cookies[0].value, "SECRET-VALUE");
  });

  test(`${target} legacy plaintext profiles are migrated`, async () => {
    const store = {
      alterlabSessionProfiles: [{ id: "sp_1", name: "old", domain: "example.com", cookies: [cookie], updatedAt: 1 }],
    };
    const ctx = loadShared(target, store);
    const [p] = await ctx.getAllSessionProfiles();
    assert.equal(p.cookies[0].value, "SECRET-VALUE");
    assert.ok(!JSON.stringify(store.alterlabSessionProfiles).includes("SECRET-VALUE"));
  });

  test(`${target} profile list is capped`, async () => {
    const store = {};
    const ctx = loadShared(target, store);
    for (let i = 0; i < 25; i++) {
      await ctx.saveSessionProfile({ name: `p${i}`, domain: "example.com", cookies: [] });
    }
    assert.equal(store.alterlabSessionProfiles.length, 20);
  });

  test(`${target} purgeLegacyDomainHistory removes only scrape history keys`, async () => {
    const store = {
      scrapeScore_a: 1,
      scrapeAnalysis_a: {},
      apiKey: "k",
      alterlabSessionProfiles: [],
    };
    const ctx = loadShared(target, store);
    assert.equal(await ctx.purgeLegacyDomainHistory(), 2);
    assert.deepEqual(Object.keys(store).sort(), ["alterlabSessionProfiles", "apiKey"]);
  });
}
