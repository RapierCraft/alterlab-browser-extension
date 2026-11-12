/**
 * AlterLab Connect: data and privacy controls (#38949).
 *
 * Pure policy and data-inventory logic; every function takes its dependencies
 * (storage, fetch, chrome wrappers) so it is unit-testable. The Chrome and
 * Firefox copies of this file are byte-identical.
 *
 * Settings live in chrome.storage.local under `privacySettings`:
 *   { localOnly, paused, retentionDays: 7 | 30 | 90 | null,
 *     sites: { "<base domain>": { never, mode: "read" | "write_approval", autoRefresh } } }
 * connect.js reads the same key (local-only guard), so the key name is shared.
 */
(function (root) {
  "use strict";

  const SETTINGS_KEY = "privacySettings";
  const RETENTION_OPTIONS = [7, 30, 90, null];
  const SITE_MODES = ["read", "write_approval"];
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Everything the extension keeps in chrome.storage.local, by category. */
  const LOCAL_CATEGORIES = [
    {
      id: "credentials",
      label: "AlterLab API key and URL",
      keys: ["apiKey", "apiUrl", "alterlabDeviceId"],
    },
    {
      id: "keys",
      label: "Per-use key shares (unlock vault sessions for your agents)",
      keys: ["connectKeyShares"],
    },
    {
      id: "sites",
      label: "Connected-site approvals (scopes, refresh state)",
      keys: ["connectApprovedSites"],
      revokeOnly: true,
    },
    {
      id: "profiles",
      label: "Saved session profiles (encrypted)",
      keys: ["alterlabSessionProfiles"],
    },
    {
      id: "queue",
      label: "Pending sync queue and scrape counters",
      keys: ["alterlabSyncQueue", "alterlabScrapeUsage"],
    },
    {
      id: "settings",
      label: "Settings, consent record and UI flags",
      keys: [
        SETTINGS_KEY,
        "cookieUploadConsent",
        "hasSeenOnboarding",
        "referralPromptShown",
        "sidepanelOpenTab",
      ],
    },
    { id: "reports", label: "Reports (none stored locally; shared reports live at AlterLab)", keys: [] },
    { id: "recordings", label: "Recordings (none stored locally)", keys: [] },
  ];

  /** Categories of data AlterLab holds for the user, and how each is exported or deleted. */
  const REMOTE_CATEGORIES = [
    { id: "sessions", label: "Sessions (sealed cookies and metadata)", export: true, delete: true },
    { id: "audit", label: "Decrypt and action audit entries", export: true, delete: true },
    { id: "reports", label: "Shared reports", export: false, delete: false, note: "Managed from the dashboard" },
    { id: "recordings", label: "Recordings", export: false, delete: false, note: "Managed from the dashboard" },
  ];

  function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function storageGet(storage, key) {
    return new Promise((resolve) =>
      storage.get(key == null ? null : key, (items) => resolve(key == null ? items || {} : (items || {})[key])),
    );
  }
  function storageSet(storage, items) {
    return new Promise((resolve) => storage.set(items, () => resolve()));
  }
  function storageRemove(storage, keys) {
    return new Promise((resolve) => storage.remove(keys, () => resolve()));
  }

  function defaults() {
    return { localOnly: false, paused: false, retentionDays: null, sites: {} };
  }

  function normalizeSite(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    return {
      never: s.never === true,
      mode: SITE_MODES.includes(s.mode) ? s.mode : "write_approval",
      autoRefresh: s.autoRefresh !== false,
    };
  }

  function normalize(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const out = defaults();
    out.localOnly = r.localOnly === true;
    out.paused = r.paused === true;
    out.retentionDays = RETENTION_OPTIONS.includes(r.retentionDays) ? r.retentionDays : null;
    for (const [domain, site] of Object.entries(r.sites || {})) out.sites[domain] = normalizeSite(site);
    return out;
  }

  async function getSettings(storage) {
    return normalize(await storageGet(storage, SETTINGS_KEY));
  }

  async function saveSettings(storage, settings) {
    const clean = normalize(settings);
    await storageSet(storage, { [SETTINGS_KEY]: clean });
    return clean;
  }

  async function setGlobal(storage, patch) {
    const s = await getSettings(storage);
    for (const k of ["localOnly", "paused", "retentionDays"]) if (k in patch) s[k] = patch[k];
    return saveSettings(storage, s);
  }

  async function setSite(storage, domain, patch) {
    const s = await getSettings(storage);
    s.sites[domain] = normalizeSite({ ...(s.sites[domain] || {}), ...patch });
    return saveSettings(storage, s);
  }

  // -- policy ---------------------------------------------------------------

  /**
   * Decide whether an agent connect request may proceed. Returns
   * { allowed: true } or { allowed: false, code, reason }; checked before any
   * consent prompt or permission request.
   */
  function decideConnect(settings, baseDomain, scopes) {
    const s = normalize(settings);
    if (s.paused) {
      return { allowed: false, code: "AGENT_PAUSED", reason: "All agent activity is paused in AlterLab Connect" };
    }
    if (s.localOnly) {
      return {
        allowed: false,
        code: "LOCAL_ONLY",
        reason: "Local-only mode is on: sessions are not uploaded to AlterLab",
      };
    }
    const site = s.sites[baseDomain];
    if (site && site.never) {
      return {
        allowed: false,
        code: "SITE_BLOCKED",
        reason: `${baseDomain} is set to never capture in AlterLab Connect`,
      };
    }
    if (site && site.mode === "read" && (scopes || []).includes("write")) {
      return {
        allowed: false,
        code: "SITE_READ_ONLY",
        reason: `${baseDomain} is set to read only; write access was requested`,
      };
    }
    return { allowed: true };
  }

  /** Whether a background refresh push may run for the site. */
  function refreshAllowed(settings, baseDomain) {
    const s = normalize(settings);
    if (s.paused) return { allowed: false, reason: "paused" };
    if (s.localOnly) return { allowed: false, reason: "local_only" };
    const site = s.sites[baseDomain];
    if (site && site.never) return { allowed: false, reason: "never" };
    if (site && !site.autoRefresh) return { allowed: false, reason: "auto_refresh_off" };
    return { allowed: true };
  }

  function assertUploadAllowed(settings) {
    if (normalize(settings).localOnly) {
      throw fail("LOCAL_ONLY", "Local-only mode is on: nothing is uploaded to AlterLab");
    }
  }

  // -- local data -----------------------------------------------------------

  /** Per category: whether anything is stored locally right now. */
  async function inventoryLocal(storage) {
    const all = await storageGet(storage, null);
    return LOCAL_CATEGORIES.map((c) => ({
      id: c.id,
      label: c.label,
      revokeOnly: c.revokeOnly === true,
      count: c.keys.filter((k) => all[k] !== undefined).length,
    }));
  }

  /** Clear one local category. `sites` is revoke-only (server state must be revoked first). */
  async function clearLocal(storage, categoryId) {
    const cat = LOCAL_CATEGORIES.find((c) => c.id === categoryId);
    if (!cat) throw fail("UNKNOWN_CATEGORY", `Unknown data category ${categoryId}`);
    if (cat.revokeOnly) throw fail("USE_REVOKE", "Revoke the connected sites instead of clearing approvals");
    if (cat.keys.length) await storageRemove(storage, cat.keys);
    return { cleared: cat.keys.length };
  }

  // -- data held by AlterLab ------------------------------------------------

  async function privacyApi(deps, method, path) {
    const cfg = await deps.getConfig();
    if (!cfg.apiKey) throw fail("NOT_CONNECTED", "Connect the extension to AlterLab first");
    const resp = await deps.fetch(`${cfg.apiUrl}/api/v1/sessions/privacy${path}`, {
      method,
      headers: { "X-API-Key": cfg.apiKey },
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw fail("API_ERROR", err.detail || `API error (HTTP ${resp.status})`);
    }
    return resp.json().catch(() => ({}));
  }

  const exportRemote = (deps) => privacyApi(deps, "GET", "/export");
  const getServerRetention = (deps) => privacyApi(deps, "GET", "/retention");

  /**
   * Delete everything AlterLab holds, then drop the local approvals, key shares
   * and per-site origin permissions that pointed at it.
   * deps also needs: storage, removeOrigin(pattern).
   */
  async function deleteAllRemote(deps) {
    const result = await privacyApi(deps, "DELETE", "/delete-all");
    const approved = (await storageGet(deps.storage, "connectApprovedSites")) || {};
    for (const domain of Object.keys(approved)) {
      try {
        await deps.removeOrigin(`*://*.${domain}/*`);
      } catch {
        // Permission already gone.
      }
    }
    await storageRemove(deps.storage, ["connectApprovedSites", "connectKeyShares"]);
    return result;
  }

  // -- retention ------------------------------------------------------------

  /**
   * Revoke connected sites whose last push is older than the retention period.
   * deps: { storage, now(), revokeSite(domain) }. No-op for "until revoked".
   */
  async function sweepRetention(deps) {
    const s = await getSettings(deps.storage);
    if (!s.retentionDays) return { revoked: [] };
    const approved = (await storageGet(deps.storage, "connectApprovedSites")) || {};
    const cutoff = deps.now() - s.retentionDays * DAY_MS;
    const revoked = [];
    for (const [domain, site] of Object.entries(approved)) {
      const last = Math.max(site.lastPushAt || 0, site.approvedAt || 0);
      if (last < cutoff) {
        await deps.revokeSite(domain);
        revoked.push(domain);
      }
    }
    return { revoked };
  }

  // -- permissions manager --------------------------------------------------

  /** Granted host permissions (origins only). deps.getAllPermissions() -> { origins }. */
  async function listPermissions(deps) {
    const granted = await deps.getAllPermissions();
    return ((granted && granted.origins) || []).slice().sort();
  }

  /** One-click revoke of a host permission via permissions.remove. */
  async function revokePermission(origin, deps) {
    const removed = await deps.removeOrigin(origin);
    return { origin, removed: removed !== false };
  }

  const apiExports = {
    SETTINGS_KEY,
    RETENTION_OPTIONS,
    LOCAL_CATEGORIES,
    REMOTE_CATEGORIES,
    defaults,
    normalize,
    getSettings,
    saveSettings,
    setGlobal,
    setSite,
    decideConnect,
    refreshAllowed,
    assertUploadAllowed,
    inventoryLocal,
    clearLocal,
    exportRemote,
    getServerRetention,
    deleteAllRemote,
    sweepRetention,
    listPermissions,
    revokePermission,
  };
  root.AlterLabPrivacy = apiExports;
  if (typeof module !== "undefined" && module.exports) module.exports = apiExports;
})(typeof globalThis !== "undefined" ? globalThis : this);
