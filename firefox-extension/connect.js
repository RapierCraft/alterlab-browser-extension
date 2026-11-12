/**
 * AlterLab Connect v2: on-request session capture, per-site consent, client-side
 * sealing, throttled refresh and revoke (#38934).
 *
 * Every function takes its dependencies (storage, fetch, WebCrypto, chrome
 * wrappers) so the flow is unit-testable. The extension and Firefox copies of
 * this file are byte-identical.
 *
 * Sealing: the captured state is AES-256-GCM encrypted in the extension with a
 * fresh key, and that key is RSA-OAEP(SHA-256) wrapped with the server public
 * key from GET /api/v1/sessions/public-key. The API stores the blob and never
 * sees plaintext (client encryption mode).
 */
(function (root) {
  "use strict";

  const APPROVED_KEY = "connectApprovedSites";
  const SHARES_KEY = "connectKeyShares";
  const REFRESH_THROTTLE_MS = 15 * 60 * 1000;
  const ACTIVITY_LIMIT = 50;
  const VALID_SCOPES = ["read", "write"];
  const VALID_MODES = ["standing", "per_use"];
  const PRIVACY_SETTINGS_KEY = "privacySettings"; // owned by privacy.js (#38949)

  function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function storageGet(storage, key) {
    return new Promise((resolve) => storage.get(key, (items) => resolve((items || {})[key])));
  }
  function storageSet(storage, items) {
    return new Promise((resolve) => storage.set(items, () => resolve()));
  }

  async function getApproved(storage) {
    return (await storageGet(storage, APPROVED_KEY)) || {};
  }
  async function putApproved(storage, map) {
    await storageSet(storage, { [APPROVED_KEY]: map });
  }

  /** Match pattern covering the site and its subdomains: the only grant requested. */
  function originPattern(baseDomain) {
    return `*://*.${baseDomain}/*`;
  }

  function cookieMatchesDomain(cookie, baseDomain) {
    const d = String((cookie && cookie.domain) || "")
      .toLowerCase()
      .replace(/^\./, "");
    return d === baseDomain || d.endsWith("." + baseDomain);
  }

  /** Validate an agent connect request; throws code INVALID_REQUEST. */
  function normalizeRequest(req, getBaseDomain) {
    if (!req || typeof req.site !== "string" || !req.site.trim()) {
      throw fail("INVALID_REQUEST", "A site is required");
    }
    let host = req.site.trim().toLowerCase();
    try {
      if (host.includes("://")) host = new URL(host).hostname;
    } catch {
      throw fail("INVALID_REQUEST", "Invalid site");
    }
    const baseDomain = String(getBaseDomain(host) || "")
      .toLowerCase()
      .replace(/^\./, "");
    if (!baseDomain || !baseDomain.includes(".")) throw fail("INVALID_REQUEST", "Invalid site");
    const scopes = Array.isArray(req.scopes) && req.scopes.length ? req.scopes : ["read"];
    if (!scopes.every((s) => VALID_SCOPES.includes(s))) {
      throw fail("INVALID_REQUEST", "Invalid scopes");
    }
    const accessMode = req.accessMode || "standing";
    if (!VALID_MODES.includes(accessMode)) throw fail("INVALID_REQUEST", "Invalid access mode");
    return {
      baseDomain,
      scopes: Array.from(new Set(scopes)),
      accessMode,
      agent: String(req.agent || "An agent").slice(0, 80),
      taskRef: typeof req.task_ref === "string" && req.task_ref ? req.task_ref.slice(0, 128) : null,
      name: `Connect: ${baseDomain}`.slice(0, 100),
    };
  }

  // -- sealing --------------------------------------------------------------

  function toB64(bytes) {
    let s = "";
    const u8 = new Uint8Array(bytes);
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }

  function pemToDer(pem) {
    const b64 = String(pem)
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s+/g, "");
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * Seal `state` to the server public key. Returns the client-encryption fields
   * of POST /api/v1/sessions / PUT /{id}/sealed.
   */
  async function sealState(crypto, publicKey, state) {
    if (!publicKey || !publicKey.available || !publicKey.key) {
      throw fail("SEALING_UNAVAILABLE", "Server sealing key is not available");
    }
    const subtle = crypto.subtle;
    const aes = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(state));
    const ct = await subtle.encrypt({ name: "AES-GCM", iv }, aes, plain);
    const raw = await subtle.exportKey("raw", aes);
    const pub = await subtle.importKey(
      "spki",
      pemToDer(publicKey.key),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const wrapped = await subtle.encrypt({ name: "RSA-OAEP" }, pub, raw);
    return {
      encrypted_cookies: `${toB64(iv)}.${toB64(ct)}`,
      wrapped_key: toB64(wrapped),
      key_version: publicKey.version === undefined ? null : publicKey.version,
    };
  }

  function stateFor(baseDomain, cookies, localStorage) {
    return {
      cookies: (cookies || []).filter((c) => cookieMatchesDomain(c, baseDomain)),
      local_storage: localStorage || {},
    };
  }

  /** Local-only mode: refuse any upload. Reads the settings privacy.js owns. */
  async function assertUploadAllowed(deps) {
    const storage = deps.storage || (root.chrome && root.chrome.storage && root.chrome.storage.local);
    if (!storage) return;
    const settings = (await storageGet(storage, PRIVACY_SETTINGS_KEY)) || {};
    if (settings.localOnly === true) {
      throw fail("LOCAL_ONLY", "Local-only mode is on: nothing is uploaded to AlterLab");
    }
  }

  async function api(deps, method, path, body) {
    if ((method === "POST" && path === "") || (method === "PUT" && path.endsWith("/sealed"))) {
      await assertUploadAllowed(deps);
    }
    const cfg = await deps.getConfig();
    if (!cfg.apiKey) throw fail("NOT_CONNECTED", "Connect the extension to AlterLab first");
    const resp = await deps.fetch(`${cfg.apiUrl}/api/v1/sessions${path}`, {
      method,
      headers: { "X-API-Key": cfg.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw fail("API_ERROR", err.detail || `API error (HTTP ${resp.status})`);
    }
    return resp.json().catch(() => ({}));
  }

  /**
   * Seal manually selected cookies for upload. Returns the client-encryption
   * fields (plus cookie_names), or null when the server has no sealing key so
   * the caller can fall back to the server-side encrypted upload.
   */
  async function sealForUpload(deps, baseDomain, cookieDict) {
    await assertUploadAllowed(deps);
    const names = Object.keys(cookieDict || {});
    if (!names.length) return null;
    const publicKey = await api(deps, "GET", "/public-key");
    if (!publicKey || !publicKey.available) return null;
    const cookies = names.map((name) => ({ name, value: cookieDict[name], domain: baseDomain }));
    const sealed = await sealState(deps.crypto, publicKey, { cookies, local_storage: {} });
    return Object.assign(sealed, { cookie_names: names });
  }

  async function captureSealed(info, deps) {
    const cookiesRes = await deps.getCookies(info.baseDomain);
    if (!cookiesRes || cookiesRes.error) {
      throw fail("CAPTURE_FAILED", (cookiesRes && cookiesRes.error) || "Capture failed");
    }
    const localStorage = await deps.getLocalStorage(info.baseDomain);
    const state = stateFor(info.baseDomain, cookiesRes.cookies, localStorage);
    const names = state.cookies.map((c) => c.name);
    if (!names.length) throw fail("NO_SESSION", "No signed-in session found for this site");
    const publicKey = await api(deps, "GET", "/public-key");
    const sealed = await sealState(deps.crypto, publicKey, state);
    return { sealed, names };
  }

  function randomShare(crypto) {
    return toB64(crypto.getRandomValues(new Uint8Array(32)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  // -- connect --------------------------------------------------------------

  /**
   * Handle an agent connect request. Nothing is read or uploaded until the user
   * approves in the extension-owned prompt AND the single-site origin permission
   * is granted. Only that site's cookies and localStorage are captured.
   *
   * deps: { getBaseDomain, confirm(info) -> Promise<boolean>, hasOrigin(pattern),
   *   getCookies(base), getLocalStorage(base), getConfig(), fetch, crypto,
   *   storage, now() }
   */
  async function requestConnect(req, deps) {
    const info = normalizeRequest(req, deps.getBaseDomain);
    // Privacy controls (#38949): paused, local-only and per-site policy decline before any prompt.
    const privacy = root.AlterLabPrivacy;
    if (privacy) {
      const verdict = privacy.decideConnect(await privacy.getSettings(deps.storage), info.baseDomain, info.scopes);
      if (!verdict.allowed) throw fail(verdict.code, verdict.reason);
    }
    await assertUploadAllowed(deps);
    let approved = false;
    try {
      approved = (await deps.confirm(info)) === true;
    } catch {
      approved = false;
    }
    if (!approved) throw fail("CONSENT_DENIED", "Connection was not approved in the extension");
    if (!(await deps.hasOrigin(originPattern(info.baseDomain)))) {
      throw fail("PERMISSION_DENIED", "Site access was not granted");
    }

    const { sealed, names } = await captureSealed(info, deps);
    const body = {
      domain: info.baseDomain,
      name: info.name,
      encryption_mode: "client",
      encrypted_cookies: sealed.encrypted_cookies,
      wrapped_key: sealed.wrapped_key,
      key_version: sealed.key_version,
      cookie_names: names,
      scopes: info.scopes,
      consent: true,
    };
    const created = await api(deps, "POST", "", body);
    const sessionId = created.session_id || created.id;
    if (!sessionId) throw fail("API_ERROR", "Session was not created");

    if (info.accessMode === "per_use") {
      await api(deps, "PUT", `/${sessionId}/access-mode`, { access_mode: "per_use" });
      const shares = (await storageGet(deps.storage, SHARES_KEY)) || {};
      shares[sessionId] = randomShare(deps.crypto);
      await storageSet(deps.storage, { [SHARES_KEY]: shares });
    }

    const approvedSites = await getApproved(deps.storage);
    approvedSites[info.baseDomain] = {
      sessionId,
      scopes: info.scopes,
      agent: info.agent,
      accessMode: info.accessMode,
      approvedAt: deps.now(),
      lastPushAt: deps.now(),
      pending: false,
      expired: false,
    };
    await putApproved(deps.storage, approvedSites);
    const done = { ok: true, session_id: sessionId, domain: info.baseDomain, scopes: info.scopes };
    // An install_hands action carries the task to resume once the site is connected (#39825).
    if (info.taskRef) done.resume = { task_ref: info.taskRef, state: "preserved" };
    return done;
  }

  // -- refresh --------------------------------------------------------------

  /**
   * Re-seal and push a refreshed session for an approved site. Throttled to one
   * push per REFRESH_THROTTLE_MS; a throttled change is marked pending and
   * pushed by refreshPending(). Unapproved sites are never read.
   * Returns { pushed } or { skipped: "not_approved" | "throttled" | "expired" }.
   */
  async function refreshSite(baseDomain, deps) {
    const approvedSites = await getApproved(deps.storage);
    const site = approvedSites[baseDomain];
    if (!site) return { skipped: "not_approved" };
    const privacy = root.AlterLabPrivacy;
    if (privacy) {
      const gate = privacy.refreshAllowed(await privacy.getSettings(deps.storage), baseDomain);
      if (!gate.allowed) return { skipped: gate.reason };
    }
    try {
      await assertUploadAllowed(deps);
    } catch {
      return { skipped: "local_only" };
    }
    if (deps.now() - site.lastPushAt < REFRESH_THROTTLE_MS) {
      if (!site.pending) {
        site.pending = true;
        await putApproved(deps.storage, approvedSites);
      }
      return { skipped: "throttled" };
    }
    const info = { baseDomain };
    let captured;
    try {
      captured = await captureSealed(info, deps);
    } catch (err) {
      if (err.code === "NO_SESSION") {
        // Signed out or expired: stop pushing and ask the user to sign in again.
        site.expired = true;
        await putApproved(deps.storage, approvedSites);
        if (deps.notifyExpired) await deps.notifyExpired(baseDomain);
        return { skipped: "expired" };
      }
      throw err;
    }
    await api(deps, "PUT", `/${site.sessionId}/sealed`, {
      encrypted_cookies: captured.sealed.encrypted_cookies,
      wrapped_key: captured.sealed.wrapped_key,
      key_version: captured.sealed.key_version,
      cookie_names: captured.names,
    });
    site.lastPushAt = deps.now();
    site.pending = false;
    site.expired = false;
    await putApproved(deps.storage, approvedSites);
    return { pushed: true };
  }

  /** Push every approved site whose change was throttled and whose window has passed. */
  async function refreshPending(deps) {
    const approvedSites = await getApproved(deps.storage);
    const results = {};
    for (const [domain, site] of Object.entries(approvedSites)) {
      if (site.pending && !site.expired) results[domain] = await refreshSite(domain, deps);
    }
    return results;
  }

  // -- revoke ---------------------------------------------------------------

  /**
   * Revoke a connected site: deactivate and delete server-side, drop the site's
   * origin permission, the local key share and the approval record.
   */
  async function revokeSite(baseDomain, deps) {
    const approvedSites = await getApproved(deps.storage);
    const site = approvedSites[baseDomain];
    if (!site) return { revoked: false };
    await api(deps, "POST", `/${site.sessionId}/deactivate`);
    await api(deps, "DELETE", `/${site.sessionId}`);
    const shares = (await storageGet(deps.storage, SHARES_KEY)) || {};
    delete shares[site.sessionId];
    await storageSet(deps.storage, { [SHARES_KEY]: shares });
    try {
      await deps.removeOrigin(originPattern(baseDomain));
    } catch {
      // Permission already gone.
    }
    delete approvedSites[baseDomain];
    await putApproved(deps.storage, approvedSites);
    return { revoked: true };
  }

  // -- activity -------------------------------------------------------------

  async function listConnected(storage) {
    const approvedSites = await getApproved(storage);
    return Object.entries(approvedSites).map(([domain, s]) => ({ domain, ...s }));
  }

  /** Decrypt-audit fallback rows, used when the Hands action audit is unavailable. */
  async function fetchDecryptActivity(deps, sites) {
    const rows = [];
    for (const site of sites) {
      const entries = await api(deps, "GET", `/${site.sessionId}/decrypt-audit?limit=${ACTIVITY_LIMIT}`);
      for (const e of Array.isArray(entries) ? entries : []) {
        rows.push({
          domain: site.domain,
          agent: site.agent,
          task: e.job_id,
          action: e.mode,
          outcome: e.outcome,
          at: e.created_at,
        });
      }
    }
    return rows;
  }

  /** Last ACTIVITY_LIMIT Hands actions (action audit), newest first. */
  async function fetchActivity(deps) {
    const sites = await listConnected(deps.storage);
    const bySession = {};
    for (const site of sites) bySession[site.sessionId] = site;
    let rows;
    try {
      const cfg = await deps.getConfig();
      if (!cfg.apiKey) throw fail("NOT_CONNECTED", "Connect the extension to AlterLab first");
      const resp = await deps.fetch(`${cfg.apiUrl}/api/v1/hands/audit?limit=${ACTIVITY_LIMIT}`, {
        method: "GET",
        headers: { "X-API-Key": cfg.apiKey },
      });
      if (!resp.ok) throw fail("API_ERROR", `API error (HTTP ${resp.status})`);
      const body = await resp.json().catch(() => ({}));
      rows = (Array.isArray(body.entries) ? body.entries : []).map((e) => {
        const site = bySession[e.session_id];
        return {
          domain: site ? site.domain : e.site,
          agent: site ? site.agent : "",
          task: e.task_id,
          action: e.action_type,
          outcome: e.outcome,
          at: e.created_at,
        };
      });
    } catch (_) {
      rows = await fetchDecryptActivity(deps, sites);
    }
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return rows.slice(0, ACTIVITY_LIMIT);
  }

  async function getKeyShare(storage, sessionId) {
    return ((await storageGet(storage, SHARES_KEY)) || {})[sessionId] || null;
  }

  const apiExports = {
    APPROVED_KEY,
    SHARES_KEY,
    REFRESH_THROTTLE_MS,
    ACTIVITY_LIMIT,
    originPattern,
    normalizeRequest,
    sealState,
    sealForUpload,
    requestConnect,
    refreshSite,
    refreshPending,
    revokeSite,
    listConnected,
    fetchActivity,
    getKeyShare,
    getApproved,
  };
  root.AlterLabConnect = apiExports;
  if (typeof module !== "undefined" && module.exports) module.exports = apiExports;
})(typeof globalThis !== "undefined" ? globalThis : this);
