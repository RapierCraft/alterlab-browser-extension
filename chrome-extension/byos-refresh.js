/**
 * AlterLab Connect - BYOS session freshness.
 *
 * Watches cookie changes for domains the user already has a saved AlterLab
 * session for, and offers (or, if the user opted in, performs) a refresh of
 * that session through PATCH /api/v1/sessions/{id}.
 *
 * Privacy model: nothing is sent unless consent is stored and the user
 * granted the optional host permission for the site; auto-refresh is OFF by
 * default; the domain->session map lives in session storage only and per-domain
 * dismissals live in side panel memory only.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AlterLabByos = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const AUTO_REFRESH_KEY = "autoRefreshByos";
  const MAP_STORAGE_KEY = "byosDomainMap";
  const DISABLED_KEY = "byosDisabledDomains"; // storage.local: the user's per-site opt-outs
  const LAST_SENT_KEY = "byosLastSent"; // storage.session: { domain: { at, names, hash } }
  const MAP_TTL_MS = 30 * 60 * 1000;
  const MAP_ALARM = "alterlab-byos-map";
  const DEBOUNCE_MS = 2000;

  function normalizeHost(host) {
    return String(host || "")
      .trim()
      .toLowerCase()
      .replace(/^\./, "");
  }

  /** A cookie set on a parent domain applies to the session's host and vice versa. */
  function domainMatches(cookieDomain, sessionDomain) {
    const c = normalizeHost(cookieDomain);
    const d = normalizeHost(sessionDomain);
    if (!c || !d) return false;
    return c === d || c.endsWith("." + d) || d.endsWith("." + c);
  }

  /** GET /api/v1/sessions body (array or {sessions}) -> { domain: sessionId } */
  function buildDomainMap(data) {
    const list = Array.isArray(data) ? data : (data && data.sessions) || [];
    const map = {};
    for (const s of list) {
      const domain = normalizeHost(s && s.domain);
      const id = s && (s.id || s.session_id);
      if (domain && id && !map[domain]) map[domain] = String(id);
    }
    return map;
  }

  /** Returns { domain, sessionId } for a changed cookie's domain, or null. */
  function findTracked(map, cookieDomain) {
    for (const domain of Object.keys(map || {})) {
      if (domainMatches(cookieDomain, domain))
        return { domain, sessionId: map[domain] };
    }
    return null;
  }

  function hostPattern(baseDomain) {
    return `*://*.${baseDomain}/*`;
  }

  /**
   * Background decision for a tracked, debounced change.
   * "ignore": nothing happens; "notify": show the bar; "auto": refresh now.
   */
  function decideBackgroundAction({ permitted, autoRefresh, consented }) {
    if (!permitted) return "ignore";
    return autoRefresh && consented ? "auto" : "notify";
  }

  /** Cookies of the tracked domain as a name->value dict (PATCH body fragment). */
  function cookieDict(cookies, domain) {
    const dict = {};
    for (const c of cookies || []) {
      if (domainMatches(c.domain, domain)) dict[c.name] = c.value;
    }
    return dict;
  }

  /** Order-independent fingerprint of a cookie set; only this hash is kept, never values. */
  function hashCookies(dict) {
    const s = Object.keys(dict)
      .sort()
      .map((k) => k + "=" + dict[k])
      .join(";");
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  /** Staleness: true when the current cookies differ from the last set sent for the domain. */
  function isStale(lastSent, domain, dict) {
    const last = lastSent && lastSent[domain];
    return !last || last.hash !== hashCookies(dict);
  }

  function isDisabled(disabledList, domain) {
    return (disabledList || []).includes(normalizeHost(domain));
  }

  /** PATCH body; throws unless consent is stored. */
  async function buildPatchBody(consent, storage, cookies, domain) {
    if (!(await consent.hasConsent(storage))) {
      const err = new Error("Consent is required before uploading cookies");
      err.code = "CONSENT_NOT_GRANTED";
      throw err;
    }
    const dict = cookieDict(cookies, domain);
    if (Object.keys(dict).length === 0) {
      const err = new Error("No cookies found for this site");
      err.code = "NO_COOKIES";
      throw err;
    }
    return { cookies: dict };
  }

  /** Trailing debounce keyed by string; timers injectable for tests. */
  function createDebouncer(ms, timers) {
    const t = timers || { set: setTimeout, clear: clearTimeout };
    const pending = new Map();
    return function (key, fn) {
      if (pending.has(key)) t.clear(pending.get(key));
      pending.set(
        key,
        t.set(() => {
          pending.delete(key);
          fn();
        }, ms),
      );
    };
  }

  /** Session-scoped (in-memory) dismissals and the queue of pending domains. */
  function createBarState() {
    const dismissed = new Set();
    const pending = new Map(); // domain -> sessionId
    return {
      /** Returns true when the bar should (still) show for this event. */
      add(domain, sessionId, autoRefresh) {
        if (autoRefresh || dismissed.has(domain)) return false;
        pending.set(domain, sessionId);
        return true;
      },
      dismiss(domain) {
        dismissed.add(domain);
        pending.delete(domain);
      },
      resolve(domain) {
        pending.delete(domain);
      },
      clear() {
        pending.clear();
      },
      next() {
        for (const [domain, sessionId] of pending) return { domain, sessionId };
        return null;
      },
    };
  }

  // -------------------------------------------------------------------------
  // Background wiring (service worker / Firefox background script)
  // -------------------------------------------------------------------------

  function startMonitor(deps) {
    const { chrome, loadConfig, getBaseDomain, notify, consent } = deps;
    const debounce = createDebouncer(DEBOUNCE_MS);
    let memo = null;
    let inflight = null;

    async function fetchMap() {
      const config = await loadConfig();
      if (!config.apiKey) return {};
      const resp = await fetch(`${config.apiUrl}/api/v1/sessions`, {
        headers: { "X-API-Key": config.apiKey },
      });
      if (!resp.ok) throw new Error(`API error (HTTP ${resp.status})`);
      const map = buildDomainMap(await resp.json());
      memo = { map, at: Date.now() };
      await chrome.storage.session.set({ [MAP_STORAGE_KEY]: memo });
      return map;
    }

    async function getMap(force) {
      if (!memo) {
        const stored = await chrome.storage.session.get(MAP_STORAGE_KEY);
        memo = stored[MAP_STORAGE_KEY] || null;
      }
      if (!force && memo && Date.now() - memo.at < MAP_TTL_MS) return memo.map;
      if (!inflight) {
        inflight = fetchMap()
          .catch(() => (memo ? memo.map : {}))
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    }

    const isPermitted = (domain) =>
      chrome.permissions.contains({
        origins: [hostPattern(getBaseDomain(domain))],
      });

    async function recordSent(domain, dict) {
      const stored = await chrome.storage.session.get(LAST_SENT_KEY);
      const all = stored[LAST_SENT_KEY] || {};
      all[domain] = {
        at: new Date().toISOString(),
        names: Object.keys(dict),
        hash: hashCookies(dict),
      };
      await chrome.storage.session.set({ [LAST_SENT_KEY]: all });
    }

    async function refreshSession(domain, sessionId, force) {
      try {
        const map = await getMap(false);
        if (map[normalizeHost(domain)] !== sessionId) {
          return { ok: false, error: "Unknown session" };
        }
        if (!(await isPermitted(domain))) {
          return { ok: false, error: "Site access was not granted" };
        }
        const config = await loadConfig();
        if (!config.apiKey) return { ok: false, error: "Not connected" };
        const cookies = await chrome.cookies.getAll({
          domain: getBaseDomain(domain),
        });
        const body = await buildPatchBody(
          consent,
          chrome.storage.local,
          cookies,
          domain,
        );
        const lastSent = (await chrome.storage.session.get(LAST_SENT_KEY))[
          LAST_SENT_KEY
        ];
        if (!force && !isStale(lastSent, normalizeHost(domain), body.cookies)) {
          return { ok: true, skipped: true };
        }
        const resp = await fetch(
          `${config.apiUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
          {
            method: "PATCH",
            headers: {
              "X-API-Key": config.apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          },
        );
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          return {
            ok: false,
            error: err.detail || `API error (HTTP ${resp.status})`,
          };
        }
        await recordSent(normalizeHost(domain), body.cookies);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message || "Refresh failed" };
      }
    }

    async function onDebounced(domain, sessionId) {
      try {
        const stored = await chrome.storage.local.get([
          AUTO_REFRESH_KEY,
          DISABLED_KEY,
        ]);
        if (isDisabled(stored[DISABLED_KEY], domain)) return;
        const action = decideBackgroundAction({
          permitted: await isPermitted(domain),
          autoRefresh: stored[AUTO_REFRESH_KEY] === true,
          consented: await consent.hasConsent(chrome.storage.local),
        });
        if (action === "auto") await refreshSession(domain, sessionId);
        else if (action === "notify")
          notify({ type: "BYOS_COOKIE_CHANGED", domain, sessionId });
      } catch (e) {
        // Monitoring is best-effort
      }
    }

    chrome.cookies.onChanged.addListener((changeInfo) => {
      const cookie = changeInfo.cookie;
      if (!cookie || !memo) {
        // Cache not loaded in this worker run yet: load it, then re-evaluate
        getMap(false)
          .then(() => {
            const hit = cookie && findTracked(memo && memo.map, cookie.domain);
            if (hit)
              debounce(hit.domain, () =>
                onDebounced(hit.domain, hit.sessionId),
              );
          })
          .catch(() => {});
        return;
      }
      const hit = findTracked(memo.map, cookie.domain);
      if (hit)
        debounce(hit.domain, () => onDebounced(hit.domain, hit.sessionId));
    });

    chrome.alarms.get(MAP_ALARM).then((a) => {
      if (!a)
        chrome.alarms.create(MAP_ALARM, {
          periodInMinutes: MAP_TTL_MS / 60000,
        });
    });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === MAP_ALARM) getMap(true).catch(() => {});
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === "REFRESH_BYOS_COOKIES") {
        refreshSession(message.domain, message.sessionId, true).then(
          sendResponse,
        );
        return true;
      }
      if (message.type === "GET_BYOS_LAST_SENT") {
        chrome.storage.session
          .get(LAST_SENT_KEY)
          .then((r) => sendResponse({ lastSent: r[LAST_SENT_KEY] || {} }));
        return true;
      }
      if (message.type === "GET_BYOS_DOMAINS") {
        getMap(message.force === true).then((map) => sendResponse({ map }));
        return true;
      }
      return undefined;
    });
  }

  return {
    AUTO_REFRESH_KEY,
    MAP_STORAGE_KEY,
    DISABLED_KEY,
    LAST_SENT_KEY,
    MAP_TTL_MS,
    DEBOUNCE_MS,
    normalizeHost,
    domainMatches,
    buildDomainMap,
    findTracked,
    hostPattern,
    decideBackgroundAction,
    cookieDict,
    hashCookies,
    isStale,
    isDisabled,
    buildPatchBody,
    createDebouncer,
    createBarState,
    startMonitor,
  };
});
