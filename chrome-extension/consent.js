/**
 * AlterLab Connect - cookie upload consent and dashboard bridge confirmation.
 *
 * Consent is a stored, timestamped record created only by an affirmative user
 * action. The upload body's `consent` flag is derived from that record and
 * never hard-coded. Dashboard-initiated capture is gated by an
 * extension-side confirmation naming the domain.
 */
(function (root) {
  "use strict";

  const CONSENT_STORAGE_KEY = "cookieUploadConsent";
  const CONSENT_VERSION = 1;

  const CONSENT_DISCLOSURE = {
    title: "Send cookies to AlterLab?",
    sent: "The cookies you selected (names and values) and the site domain.",
    recipient:
      "Your AlterLab account, over HTTPS. Cookies are encrypted at rest (AES-256-GCM) and values are never logged.",
    retention:
      "Kept until you delete the saved session in AlterLab. Deleting it removes the data.",
    note: "Cookies can contain sign-in credentials. Upload only cookies for accounts you are entitled to use. If you turn on automatic session refresh, the cookies of your saved sessions' sites are sent again whenever they change while the side panel is open. You can revoke this consent at any time in Settings.",
  };

  function storageGet(storage, key) {
    return new Promise((resolve) => {
      storage.get(key, (items) => resolve((items || {})[key]));
    });
  }

  function storageSet(storage, items) {
    return new Promise((resolve) => storage.set(items, () => resolve()));
  }

  function storageRemove(storage, key) {
    return new Promise((resolve) => storage.remove(key, () => resolve()));
  }

  async function getConsent(storage) {
    const rec = await storageGet(storage, CONSENT_STORAGE_KEY);
    if (!rec || rec.granted !== true || !rec.grantedAt) return null;
    return rec;
  }

  async function hasConsent(storage) {
    return (await getConsent(storage)) !== null;
  }

  async function grantConsent(storage, now) {
    const rec = {
      granted: true,
      grantedAt: new Date(now === undefined ? Date.now() : now).toISOString(),
      version: CONSENT_VERSION,
    };
    await storageSet(storage, { [CONSENT_STORAGE_KEY]: rec });
    return rec;
  }

  async function revokeConsent(storage) {
    await storageRemove(storage, CONSENT_STORAGE_KEY);
  }

  /**
   * Capture-time browser context (#38932): the API pins every later run of the
   * session to this fingerprint and a matching exit.
   */
  function captureContext() {
    const nav = typeof navigator !== "undefined" ? navigator : {};
    let timezone = "";
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (_) {}
    return {
      user_agent: nav.userAgent || "",
      platform: nav.platform || "",
      locale: nav.language || "",
      timezone,
      languages: Array.from(nav.languages || []).slice(0, 8),
    };
  }

  /**
   * Build the POST /api/v1/sessions body. Throws unless a consent record
   * exists, so no upload payload can be produced before consent.
   */
  async function buildSessionBody(storage, fields) {
    if (!(await hasConsent(storage))) {
      const err = new Error("Consent is required before uploading cookies");
      err.code = "CONSENT_NOT_GRANTED";
      throw err;
    }
    const body = {
      domain: fields.domain,
      name: fields.name,
      consent: true,
      capture_context: fields.captureContext || captureContext(),
    };
    if (fields.scopes) body.scopes = fields.scopes;
    if (fields.sealed) {
      // Client-sealed upload (AlterLab Connect v2): no plaintext cookies in the body.
      return Object.assign(body, {
        encryption_mode: "client",
        encrypted_cookies: fields.sealed.encrypted_cookies,
        wrapped_key: fields.sealed.wrapped_key,
        key_version: fields.sealed.key_version,
        cookie_names: fields.sealed.cookie_names,
      });
    }
    body.cookies = fields.cookies;
    return body;
  }

  function normalizeHost(host) {
    return String(host || "")
      .trim()
      .toLowerCase()
      .replace(/^\./, "");
  }

  function cookieMatchesDomain(cookie, baseDomain) {
    const d = normalizeHost(cookie && cookie.domain);
    return d === baseDomain || d.endsWith("." + baseDomain);
  }

  /**
   * Dashboard bridge: ask the user (extension-side) to confirm the domain,
   * then return cookies only for that confirmed base domain.
   *
   * deps: { getBaseDomain(host), confirm(baseDomain) -> Promise<boolean>,
   *         getCookies(baseDomain) -> Promise<{cookies, error}> }
   */
  async function captureForDashboard(domain, deps) {
    if (!domain || typeof domain !== "string") {
      return { cookies: [], error: "Invalid domain" };
    }
    const baseDomain = normalizeHost(deps.getBaseDomain(normalizeHost(domain)));
    if (!baseDomain) return { cookies: [], error: "Invalid domain" };

    let approved = false;
    try {
      approved = (await deps.confirm(baseDomain)) === true;
    } catch (e) {
      approved = false;
    }
    if (!approved) {
      return {
        cookies: [],
        error: "Cookie capture was not confirmed in the AlterLab extension",
      };
    }

    const result = await deps.getCookies(baseDomain);
    if (!result || result.error) {
      return { cookies: [], error: (result && result.error) || "Extension error" };
    }
    return {
      cookies: (result.cookies || []).filter((c) => cookieMatchesDomain(c, baseDomain)),
      error: null,
    };
  }

  /**
   * Show the disclosure and resolve true only on an affirmative click.
   * Resolves true immediately when consent is already stored.
   */
  async function requestUploadConsent(doc, storage) {
    if (await hasConsent(storage)) return true;
    return new Promise((resolve) => {
      const overlay = doc.createElement("div");
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:12px;";
      const box = doc.createElement("div");
      box.style.cssText =
        "background:#1c1917;color:#fafaf9;border-radius:8px;padding:14px;max-width:340px;font:12px/1.5 system-ui,sans-serif;";
      const rows = [
        ["What is sent", CONSENT_DISCLOSURE.sent],
        ["Who receives it", CONSENT_DISCLOSURE.recipient],
        ["Retention", CONSENT_DISCLOSURE.retention],
      ];
      const h = doc.createElement("div");
      h.style.cssText = "font-weight:600;font-size:13px;margin-bottom:8px;";
      h.textContent = CONSENT_DISCLOSURE.title;
      box.appendChild(h);
      for (const [label, text] of rows) {
        const p = doc.createElement("p");
        p.style.margin = "0 0 6px";
        const b = doc.createElement("strong");
        b.textContent = label + ": ";
        p.appendChild(b);
        p.appendChild(doc.createTextNode(text));
        box.appendChild(p);
      }
      const note = doc.createElement("p");
      note.style.cssText = "margin:0 0 10px;opacity:.8;";
      note.textContent = CONSENT_DISCLOSURE.note;
      box.appendChild(note);

      const finish = async (ok) => {
        if (ok) await grantConsent(storage);
        overlay.remove();
        resolve(ok);
      };
      const mk = (text, ok) => {
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.textContent = text;
        btn.style.cssText = "margin-right:8px;padding:6px 10px;cursor:pointer;";
        btn.addEventListener("click", () => finish(ok));
        return btn;
      };
      box.appendChild(mk("I agree, upload cookies", true));
      box.appendChild(mk("Cancel", false));
      overlay.appendChild(box);
      doc.body.appendChild(overlay);
    });
  }

  const api = {
    CONSENT_STORAGE_KEY,
    CONSENT_VERSION,
    CONSENT_DISCLOSURE,
    getConsent,
    hasConsent,
    grantConsent,
    revokeConsent,
    buildSessionBody,
    captureContext,
    captureForDashboard,
    requestUploadConsent,
  };
  root.AlterLabConsent = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
