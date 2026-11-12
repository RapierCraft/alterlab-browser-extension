import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

const require = createRequire(import.meta.url);
const H = require("../hands-credentials.js");

const req = {
  request_id: "c1", task_id: "t1", domain: "example.com", status: "pending",
  expires_at: "2999-01-01T00:00:00Z", reuse: "standing", valid_until: "2030-01-01", use_limit: 3,
  ask_each_time: true, reason: "Log in to pull invoices",
  fields: [{ name: "username", kind: "username" }, { name: "password", kind: "password", label: "Account password" }],
};
const SECRET = "hunter2-very-secret";

function b64u(bytes) { return Buffer.from(bytes).toString("base64url"); }
function unb64u(text) { return new Uint8Array(Buffer.from(text, "base64url")); }

async function makeEntry() {
  const kp = await webcrypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey));
  return {
    kp, pub,
    entry: { request: req, envelope: { key_id: "kid12345", public_key: b64u(pub), algorithm: "x25519-aesgcm-v1" }, aad: `alterlab-hands-envelope-v1|c1|example.com` },
  };
}

// Independent opener following shared/security/envelope.py (open_sealed).
async function open(kp, pub, entry, blob) {
  const [ver, eph, body] = blob.split(".");
  assert.equal(ver, "v1");
  const ephPub = unb64u(eph);
  const raw = unb64u(body);
  const ephKey = await webcrypto.subtle.importKey("raw", ephPub, { name: "X25519" }, false, []);
  const shared = await webcrypto.subtle.deriveBits({ name: "X25519", public: ephKey }, kp.privateKey, 256);
  const salt = new Uint8Array([...ephPub, ...pub]);
  const hk = await webcrypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("alterlab-hands-envelope-v1") },
    hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(0, 12), additionalData: new TextEncoder().encode(entry.aad) }, key, raw.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

function deps(handlers, calls = []) {
  return {
    baseUrl: "https://api.test",
    headers: { "X-API-Key": "k" },
    crypto: webcrypto,
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      const h = handlers.find((x) => url.includes(x.match));
      return { ok: h.ok !== false, status: h.status || 200, json: async () => h.body };
    },
    notify: async () => {},
  };
}

test("chrome and firefox modules are identical", () => {
  assert.equal(
    readFileSync(new URL("../hands-credentials.js", import.meta.url), "utf8"),
    readFileSync(new URL("../../firefox-extension/hands-credentials.js", import.meta.url), "utf8"),
  );
  for (const f of ["credential-request.js", "credential-request.html"]) {
    assert.equal(
      readFileSync(new URL(`../${f}`, import.meta.url), "utf8"),
      readFileSync(new URL(`../../firefox-extension/${f}`, import.meta.url), "utf8"),
    );
  }
});

test("poll notifies each pending unexpired request once, without values", async () => {
  const notes = [];
  const d = deps([{ match: "credential-requests", body: { requests: [req, { ...req, request_id: "c2", status: "provided" }, { ...req, request_id: "c3", expires_at: "2000-01-01T00:00:00Z" }] } }]);
  d.notify = async (id, options) => notes.push({ id, options });
  await H.poll(d);
  await H.poll(d);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, H.NOTIFY_PREFIX + "c1");
  assert.match(notes[0].options.title, /example\.com/);
  assert.match(notes[0].options.message, /Log in to pull invoices/);
  assert.match(notes[0].options.message, /Account password/);
});

test("retention mirrors the entry page", () => {
  const text = H.retention(req);
  assert.match(text, /later tasks/);
  assert.match(text, /until 2030-01-01/);
  assert.match(text, /3 uses max/);
  assert.match(text, /asks you each time/);
});

test("sealPayload round-trips and hides the plaintext", async () => {
  const { kp, pub, entry } = await makeEntry();
  const out = await H.sealPayload(entry, { username: "me", password: SECRET }, webcrypto);
  assert.equal(out.key_id, "kid12345");
  assert.ok(!out.sealed.includes(SECRET) && !Buffer.from(out.sealed).toString("latin1").includes(SECRET));
  assert.deepEqual(await open(kp, pub, entry, out.sealed), { username: "me", password: SECRET });
  await assert.rejects(open(kp, pub, { ...entry, aad: "other|c1|evil.com" }, out.sealed));
});

test("provide posts only ciphertext", async () => {
  const { kp, pub, entry } = await makeEntry();
  const calls = [];
  const d = deps([{ match: "/entry", body: entry }, { match: "/provide", body: { status: "provided" } }], calls);
  assert.equal(await H.provide("c1", "ABCDEFGH", { password: SECRET }, d), true);
  const post = calls.find((c) => c.url.endsWith("/provide"));
  assert.deepEqual(Object.keys(JSON.parse(post.init.body)).sort(), ["key_id", "sealed", "short_code"]);
  assert.ok(!JSON.stringify(calls).includes(SECRET));
  assert.deepEqual(await open(kp, pub, entry, JSON.parse(post.init.body).sealed), { password: SECRET });
});

test("sealing fails closed without X25519 and makes no provide call", async () => {
  const { entry } = await makeEntry();
  const calls = [];
  const d = deps([{ match: "/entry", body: entry }, { match: "/provide", body: {} }], calls);
  d.crypto = { subtle: { generateKey: async () => { throw new Error("NotSupportedError"); } }, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
  await assert.rejects(H.provide("c1", "ABCDEFGH", { password: SECRET }, d), { code: "SEALING_UNAVAILABLE" });
  assert.ok(!calls.some((c) => c.url.endsWith("/provide")));
});

test("wrong short code surfaces INVALID_CODE; decline posts", async () => {
  const calls = [];
  const d = deps([{ match: "/entry", ok: false, status: 403, body: {} }, { match: "/decline", body: {} }], calls);
  await assert.rejects(H.provide("c1", "WRONGCODE", {}, d), { code: "INVALID_CODE" });
  assert.equal(await H.decline("c1", d), true);
  assert.equal(calls.at(-1).init.method, "POST");
});

test("extension uses the session proxy, needs no short code and never an API key (#40036)", async () => {
  const { entry } = await makeEntry();
  const calls = [];
  const d = { ...deps([{ match: "/entry", body: entry }, { match: "/provide", body: {} }, { match: "/decline", body: {} }], calls), headers: {} };
  assert.equal(await H.provide("c1", "", { password: SECRET }, d), true);
  assert.equal(await H.decline("c1", d), true);
  for (const c of calls) {
    assert.ok(c.url.startsWith("https://api.test/api/account/hands/credential-requests/"), c.url);
    assert.equal(c.init.credentials, "include");
    assert.ok(!("X-API-Key" in (c.init.headers || {})));
  }
  assert.ok(!calls[0].url.includes("short_code"));
  const body = JSON.parse(calls.find((c) => c.url.endsWith("/provide")).init.body);
  assert.ok(!("short_code" in body));
});
