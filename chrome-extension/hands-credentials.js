/**
 * AlterLab Connect - Hands credential requests (#39876).
 *
 * Polls the caller's pending credential requests, notifies once per request, and seals the
 * values the user types to the API's envelope key inside the browser (X25519 + HKDF-SHA256 +
 * AES-256-GCM, mirroring shared/security/envelope.py). Only the ciphertext is sent: the API,
 * the notification and the logs never see a value. Fails closed when X25519 is unavailable.
 */
(function (root) {
  "use strict";

  const NOTIFY_PREFIX = "alterlab-credential:";
  // Session-authenticated proxy (#40036): the extension is the user's own channel and never
  // carries an API key, which the API refuses on these routes.
  const BASE = "/api/account/hands/credential-requests";
  const INFO = "alterlab-hands-envelope-v1";
  const VERSION = "v1";

  function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function toB64Url(bytes) {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64Url(text) {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function headersOf(deps, extra) {
    const base = typeof deps.headers === "function" ? await deps.headers() : deps.headers || {};
    return { ...base, ...(extra || {}) };
  }

  function retention(req) {
    const reuse = { once: "used once, then discarded", task: "kept for this task", standing: "kept for later tasks on this site" }[req.reuse] || req.reuse;
    const parts = [reuse];
    if (req.valid_until) parts.push(`until ${req.valid_until}`);
    if (req.use_limit) parts.push(`${req.use_limit} use${req.use_limit === 1 ? "" : "s"} max`);
    if (req.ask_each_time) parts.push("asks you each time");
    return parts.join(", ");
  }

  function fieldLabel(field) {
    return field.label || String(field.name || "").replace(/_/g, " ");
  }

  function describe(req) {
    const names = (req.fields || []).map(fieldLabel).join(", ");
    const why = req.reason ? `${req.reason} ` : "";
    return {
      title: `Your agent needs a credential for ${req.domain}`,
      message: `${why}Requested: ${names || "credential"}. Enter it in the extension; it is sealed before it leaves your browser.`,
    };
  }

  async function fetchPending(deps) {
    const resp = await deps.fetch(`${deps.baseUrl}${BASE}`, {
      headers: await headersOf(deps),
      credentials: "include",
    });
    if (!resp.ok) return [];
    const body = await resp.json();
    const rows = Array.isArray(body) ? body : (body && body.requests) || [];
    const now = deps.now ? deps.now() : Date.now();
    return rows.filter((r) => r.status === "pending" && Date.parse(r.expires_at) > now);
  }

  async function getRequest(requestId, deps) {
    const resp = await deps.fetch(`${deps.baseUrl}${BASE}/${encodeURIComponent(requestId)}`, {
      headers: await headersOf(deps),
      credentials: "include",
    });
    return resp.ok ? resp.json() : null;
  }

  async function poll(deps) {
    const seen = deps.seen || (deps.seen = new Set());
    const pending = await fetchPending(deps);
    for (const req of pending) {
      if (seen.has(req.request_id)) continue;
      seen.add(req.request_id);
      const { title, message } = describe(req);
      await deps.notify(NOTIFY_PREFIX + req.request_id, {
        type: "basic",
        title,
        message,
        requireInteraction: true,
      }, req);
    }
    return pending;
  }

  async function getEntry(requestId, shortCode, deps) {
    const code = shortCode ? `?short_code=${encodeURIComponent(shortCode)}` : "";
    const url = `${deps.baseUrl}${BASE}/${encodeURIComponent(requestId)}/entry${code}`;
    const resp = await deps.fetch(url, { headers: await headersOf(deps), credentials: "include" });
    if (!resp.ok) throw fail(resp.status === 403 ? "INVALID_CODE" : "ENTRY_FAILED", `Entry failed (${resp.status})`);
    return resp.json();
  }

  /** Seal `values` ({field name: string}) to entry.envelope.public_key bound to entry.aad. */
  async function sealPayload(entry, values, crypto) {
    const subtle = crypto && crypto.subtle;
    const env = entry && entry.envelope;
    if (!subtle || !env || env.algorithm !== "x25519-aesgcm-v1" || !env.public_key) {
      throw fail("SEALING_UNAVAILABLE", "Sealing is not available; update your browser");
    }
    let eph;
    let key;
    const recipient = fromB64Url(env.public_key);
    try {
      eph = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
      const recipientKey = await subtle.importKey("raw", recipient, { name: "X25519" }, false, []);
      const shared = await subtle.deriveBits({ name: "X25519", public: recipientKey }, eph.privateKey, 256);
      const ephPub = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
      const salt = new Uint8Array(ephPub.length + recipient.length);
      salt.set(ephPub);
      salt.set(recipient, ephPub.length);
      const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
      key = await subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(INFO) },
        hkdf,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"],
      );
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(entry.aad) },
        key,
        new TextEncoder().encode(JSON.stringify(values)),
      ));
      const body = new Uint8Array(nonce.length + ct.length);
      body.set(nonce);
      body.set(ct, nonce.length);
      return { key_id: env.key_id, sealed: `${VERSION}.${toB64Url(ephPub)}.${toB64Url(body)}` };
    } catch (err) {
      if (err && err.code) throw err;
      throw fail("SEALING_UNAVAILABLE", "Sealing is not available; update your browser");
    }
  }

  /** Fetch the entry data, seal, and post ciphertext only. Values never leave this function. */
  async function provide(requestId, shortCode, values, deps) {
    const entry = await getEntry(requestId, shortCode, deps);
    const { key_id, sealed } = await sealPayload(entry, values, deps.crypto);
    const resp = await deps.fetch(`${deps.baseUrl}${BASE}/${encodeURIComponent(requestId)}/provide`, {
      method: "POST",
      headers: await headersOf(deps, { "Content-Type": "application/json" }),
      credentials: "include",
      body: JSON.stringify({ ...(shortCode ? { short_code: shortCode } : {}), key_id, sealed }),
    });
    if (!resp.ok) throw fail("PROVIDE_FAILED", `Provide failed (${resp.status})`);
    return true;
  }

  async function decline(requestId, deps) {
    const resp = await deps.fetch(`${deps.baseUrl}${BASE}/${encodeURIComponent(requestId)}/decline`, {
      method: "POST",
      headers: await headersOf(deps),
      credentials: "include",
    });
    return resp.ok;
  }

  const api = { NOTIFY_PREFIX, describe, retention, fieldLabel, fetchPending, getRequest, poll, getEntry, sealPayload, provide, decline };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AlterLabHandsCredentials = api;
})(typeof self !== "undefined" ? self : this);
