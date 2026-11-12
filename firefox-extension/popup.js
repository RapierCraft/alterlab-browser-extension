/**
 * AlterLab Cookie Capture - Popup Script
 *
 * Handles cookie capture, selection, preview, and push to AlterLab
 * sessions API for BYOS (Bring Your Own Session) scraping.
 */

const DEFAULT_API_URL = "https://alterlab.io";

/**
 * Cookie name patterns that commonly indicate authentication state.
 * Used for the "Auth only" selection shortcut.
 */
const AUTH_COOKIE_PATTERNS = [
  // Generic auth patterns
  /^sess/i,
  /session/i,
  /^sid$/i,
  /^auth/i,
  /^token/i,
  /^jwt/i,
  /^access.?token/i,
  /^refresh.?token/i,
  /csrf/i,
  /xsrf/i,
  /^_csrf/i,
  /^__cf_bm$/i,
  /^cf_clearance$/i,

  // Platform-specific auth cookies
  /^session-id/i, // Amazon
  /^ubid-/i, // Amazon
  /^at-/i, // Amazon
  /^x-/i, // Amazon
  /^li_at$/i, // LinkedIn
  /^JSESSIONID$/i, // Java apps
  /^connect\.sid$/i, // Express.js
  /^laravel_session$/i, // Laravel
  /^PHPSESSID$/i, // PHP
  /^ASP\.NET_SessionId$/i, // ASP.NET
  /^wordpress_logged_in/i, // WordPress
  /^__Secure-/i, // Secure prefixed cookies
  /^__Host-/i, // Host prefixed cookies
];

// DOM references
const elements = {
  setupView: document.getElementById("setupView"),
  captureView: document.getElementById("captureView"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  apiUrlInput: document.getElementById("apiUrlInput"),
  saveKeyBtn: document.getElementById("saveKeyBtn"),
  setupStatus: document.getElementById("setupStatus"),
  domainBadge: document.getElementById("domainBadge"),
  cookieCount: document.getElementById("cookieCount"),
  cookieList: document.getElementById("cookieList"),
  sessionName: document.getElementById("sessionName"),
  saveBtn: document.getElementById("saveBtn"),
  copyBtn: document.getElementById("copyBtn"),
  captureStatus: document.getElementById("captureStatus"),
  settingsBtn: document.getElementById("settingsBtn"),
  revokeConsentBtn: document.getElementById("revokeConsentBtn"),
  selectAllBtn: document.getElementById("selectAllBtn"),
  selectNoneBtn: document.getElementById("selectNoneBtn"),
  selectAuthBtn: document.getElementById("selectAuthBtn"),
  selectedCount: document.getElementById("selectedCount"),
};

// State
let currentCookies = [];
let selectedCookieKeys = new Set();
let currentDomain = "";

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  const config = await loadConfig();

  if (!config.apiKey) {
    // No API key — open sidebar directly (zero-friction experience)
    // The sidebar shows Scrape Score and all free tools without auth
    try {
      await browser.sidebarAction.open();
      window.close(); // Close popup since sidebar is now open
      return;
    } catch {
      // Sidebar open failed — fall through to cookie capture view
    }
    // Fallback: show cookie capture view (browsing works without API key)
    await showCaptureView();
  } else {
    await showCaptureView();
  }

  bindEvents();
});

function bindEvents() {
  elements.saveKeyBtn.addEventListener("click", handleSaveKey);
  elements.saveBtn.addEventListener("click", handleSaveToAlterLab);
  elements.revokeConsentBtn.addEventListener("click", async () => {
    await AlterLabConsent.revokeConsent(chrome.storage.local);
    elements.revokeConsentBtn.textContent = "Consent revoked";
  });
  elements.copyBtn.addEventListener("click", handleCopyJson);
  elements.settingsBtn.addEventListener("click", showSetupView);
  elements.selectAllBtn.addEventListener("click", handleSelectAll);
  elements.selectNoneBtn.addEventListener("click", handleSelectNone);
  elements.selectAuthBtn.addEventListener("click", handleSelectAuth);

  // Allow Enter key in API key input
  elements.apiKeyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSaveKey();
  });
}

// ---------------------------------------------------------------------------
// Config (chrome.storage.local)
// ---------------------------------------------------------------------------

async function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["apiKey", "apiUrl"], (result) => {
      resolve({
        apiKey: result.apiKey || "",
        apiUrl: result.apiUrl || DEFAULT_API_URL,
      });
    });
  });
}

async function saveConfig(apiKey, apiUrl) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ apiKey, apiUrl }, resolve);
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function showSetupView() {
  elements.setupView.classList.remove("al-hidden");
  elements.captureView.classList.add("al-hidden");
  hideStatus(elements.setupStatus);

  // Pre-fill with saved values
  loadConfig().then((config) => {
    if (config.apiKey) {
      elements.apiKeyInput.value = config.apiKey;
    }
    elements.apiUrlInput.value = config.apiUrl || DEFAULT_API_URL;
  });
}

async function showCaptureView() {
  elements.setupView.classList.add("al-hidden");
  elements.captureView.classList.remove("al-hidden");
  hideStatus(elements.captureStatus);

  await captureCookies();
}

// ---------------------------------------------------------------------------
// API Key Setup
// ---------------------------------------------------------------------------

async function handleSaveKey() {
  const apiKey = elements.apiKeyInput.value.trim();
  const apiUrl = elements.apiUrlInput.value.trim() || DEFAULT_API_URL;

  if (!apiKey) {
    showStatus(elements.setupStatus, "error", "Please enter your API key.");
    return;
  }

  if (!apiKey.startsWith("sk_live_")) {
    showStatus(
      elements.setupStatus,
      "error",
      'API key should start with "sk_live_".',
    );
    return;
  }

  elements.saveKeyBtn.disabled = true;
  elements.saveKeyBtn.innerHTML = '<span class="al-spinner al-spinner-sm al-spinner-white"></span>';

  try {
    // Validate the key by calling a lightweight endpoint
    const resp = await fetch(`${normalizeUrl(apiUrl)}/api/v1/auth/me`, {
      method: "GET",
      headers: { "X-API-Key": apiKey },
    });

    if (!resp.ok) {
      throw new Error(`Invalid API key (HTTP ${resp.status})`);
    }

    await saveConfig(apiKey, normalizeUrl(apiUrl));

    // Notify background to update badge
    chrome.runtime.sendMessage({ type: "CONFIG_UPDATED" });

    await showCaptureView();
  } catch (err) {
    showStatus(
      elements.setupStatus,
      "error",
      err.message || "Failed to validate API key.",
    );
  } finally {
    elements.saveKeyBtn.disabled = false;
    elements.saveKeyBtn.textContent = "Save";
  }
}

// ---------------------------------------------------------------------------
// Cookie Capture
// ---------------------------------------------------------------------------

async function captureCookies() {
  try {
    // Get active tab
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab || !tab.url) {
      elements.domainBadge.textContent = "No tab";
      elements.cookieCount.textContent = "Cannot read this page";
      return;
    }

    const url = new URL(tab.url);

    // about:, moz-extension:// and extension pages don't have cookies
    if (
      !url.hostname ||
      url.protocol === "about:" ||
      url.protocol === "moz-extension:"
    ) {
      elements.domainBadge.textContent = url.hostname || "N/A";
      elements.cookieCount.textContent = "Cannot read cookies from this page";
      elements.saveBtn.disabled = true;
      elements.copyBtn.disabled = true;
      return;
    }

    currentDomain = url.hostname;
    elements.domainBadge.textContent = currentDomain;

    // Get all cookies for the domain (including parent domain cookies)
    const baseDomain = getBaseDomain(currentDomain);
    const cookies = await chrome.cookies.getAll({ domain: baseDomain });

    // Also get cookies set on the exact hostname (some are set without leading dot)
    const exactCookies = await chrome.cookies.getAll({ url: tab.url });

    // Merge and deduplicate by name+domain+path
    const seen = new Set();
    currentCookies = [];
    for (const cookie of [...cookies, ...exactCookies]) {
      const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        currentCookies.push(cookie);
      }
    }

    // Sort: auth cookies first, then alphabetical
    currentCookies.sort((a, b) => {
      const aIsAuth = isAuthCookie(a.name);
      const bIsAuth = isAuthCookie(b.name);
      if (aIsAuth && !bIsAuth) return -1;
      if (!aIsAuth && bIsAuth) return 1;
      return a.name.localeCompare(b.name);
    });

    elements.cookieCount.textContent = `${currentCookies.length} cookie${currentCookies.length !== 1 ? "s" : ""}`;

    // Auto-select auth cookies by default
    selectedCookieKeys = new Set();
    for (const cookie of currentCookies) {
      if (isAuthCookie(cookie.name)) {
        selectedCookieKeys.add(cookieKey(cookie));
      }
    }

    // If no auth cookies detected, select all
    if (selectedCookieKeys.size === 0) {
      for (const cookie of currentCookies) {
        selectedCookieKeys.add(cookieKey(cookie));
      }
    }

    // Render cookie list with checkboxes
    renderCookieList();
    updateSelectedCount();

    // Auto-generate session name
    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const now = new Date();
    const prettyDomain =
      baseDomain.charAt(0).toUpperCase() + baseDomain.slice(1);
    elements.sessionName.value = `${prettyDomain} - ${monthNames[now.getMonth()]} ${now.getFullYear()}`;

    // Enable/disable buttons
    const hasCookies = currentCookies.length > 0;
    elements.saveBtn.disabled = !hasCookies;
    elements.copyBtn.disabled = !hasCookies;
  } catch (err) {
    elements.domainBadge.textContent = "Error";
    elements.cookieCount.textContent = err.message;
  }
}

function renderCookieList() {
  elements.cookieList.innerHTML = "";

  if (currentCookies.length === 0) {
    const empty = document.createElement("div");
    empty.className = "al-list-item";
    empty.innerHTML =
      '<span style="color: var(--al-text-muted)">No cookies found for this domain</span>';
    elements.cookieList.appendChild(empty);
    return;
  }

  for (const cookie of currentCookies) {
    const key = cookieKey(cookie);
    const isAuth = isAuthCookie(cookie.name);

    const item = document.createElement("div");
    item.className = "al-list-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "al-checkbox";
    checkbox.checked = selectedCookieKeys.has(key);
    checkbox.dataset.cookieKey = key;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedCookieKeys.add(key);
      } else {
        selectedCookieKeys.delete(key);
      }
      updateSelectedCount();
    });

    const name = document.createElement("span");
    name.className = "al-list-item-name" + (isAuth ? " al-badge-success" : "");
    name.style.color = isAuth ? "var(--al-success)" : "";
    name.textContent = cookie.name;
    name.title = `${cookie.name} (${cookie.domain})`;

    const flags = document.createElement("span");
    flags.className = "al-list-item-meta";

    if (isAuth) {
      const flag = document.createElement("span");
      flag.className = "al-flag";
      flag.style.color = "var(--al-accent-text)";
      flag.style.borderColor = "var(--al-accent)";
      flag.textContent = "Auth";
      flags.appendChild(flag);
    }

    if (cookie.secure) {
      const flag = document.createElement("span");
      flag.className = "al-flag";
      flag.style.color = "var(--al-success)";
      flag.style.borderColor = "var(--al-success)";
      flag.textContent = "Secure";
      flags.appendChild(flag);
    }

    if (cookie.httpOnly) {
      const flag = document.createElement("span");
      flag.className = "al-flag";
      flag.style.color = "var(--al-warning)";
      flag.style.borderColor = "var(--al-warning)";
      flag.textContent = "HttpOnly";
      flags.appendChild(flag);
    }

    item.appendChild(checkbox);
    item.appendChild(name);
    item.appendChild(flags);

    // Clicking the row toggles the checkbox
    item.addEventListener("click", (e) => {
      if (e.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change"));
    });

    elements.cookieList.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Selection Controls
// ---------------------------------------------------------------------------

function handleSelectAll() {
  selectedCookieKeys = new Set(currentCookies.map(cookieKey));
  syncCheckboxes();
  updateSelectedCount();
}

function handleSelectNone() {
  selectedCookieKeys = new Set();
  syncCheckboxes();
  updateSelectedCount();
}

function handleSelectAuth() {
  selectedCookieKeys = new Set();
  for (const cookie of currentCookies) {
    if (isAuthCookie(cookie.name)) {
      selectedCookieKeys.add(cookieKey(cookie));
    }
  }
  syncCheckboxes();
  updateSelectedCount();
}

function syncCheckboxes() {
  const checkboxes = elements.cookieList.querySelectorAll(
    'input[type="checkbox"]',
  );
  for (const cb of checkboxes) {
    cb.checked = selectedCookieKeys.has(cb.dataset.cookieKey);
  }
}

function updateSelectedCount() {
  const count = selectedCookieKeys.size;
  elements.selectedCount.textContent = `${count} selected`;
  elements.saveBtn.disabled = count === 0;
  elements.copyBtn.disabled = count === 0;
}

// ---------------------------------------------------------------------------
// Save to AlterLab
// ---------------------------------------------------------------------------

async function handleSaveToAlterLab() {
  if (selectedCookieKeys.size === 0) return;

  const config = await loadConfig();
  if (!config.apiKey) {
    showSetupView();
    return;
  }

  // Disclosure + affirmative action required before any cookie leaves the browser
  if (!(await AlterLabConsent.requestUploadConsent(document, chrome.storage.local))) {
    showStatus(
      elements.captureStatus,
      "error",
      "Upload cancelled. Consent is required to send cookies to AlterLab.",
    );
    return;
  }

  const sessionName = elements.sessionName.value.trim() || currentDomain;

  elements.saveBtn.disabled = true;
  elements.saveBtn.innerHTML = '<span class="al-spinner al-spinner-sm al-spinner-white"></span> Saving...';
  hideStatus(elements.captureStatus);

  try {
    // Build cookies as Dict[str, str] (name -> value) matching SessionCreate schema
    const cookieDict = {};
    for (const cookie of currentCookies) {
      if (selectedCookieKeys.has(cookieKey(cookie))) {
        cookieDict[cookie.name] = cookie.value;
      }
    }

    // Seal client-side (AlterLab Connect v2); falls back to the server-side
    // encrypted upload only when the server has no sealing key.
    const sealed = await AlterLabConnect.sealForUpload(
      { getConfig: async () => config, fetch: fetch.bind(window), crypto: window.crypto },
      currentDomain,
      cookieDict,
    );
    const body = await AlterLabConsent.buildSessionBody(chrome.storage.local, {
      domain: currentDomain,
      name: sessionName,
      cookies: cookieDict,
      sealed,
    });

    const resp = await fetch(`${config.apiUrl}/api/v1/sessions`, {
      method: "POST",
      headers: {
        "X-API-Key": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.detail || `API error (HTTP ${resp.status})`);
    }

    const result = await resp.json();
    const sessionId = result.session_id || result.id || "saved";

    showStatus(
      elements.captureStatus,
      "success",
      `Session saved! ID: <code>${sessionId}</code>`,
    );

    // Notify background to update badge
    chrome.runtime.sendMessage({ type: "SESSION_SAVED", domain: currentDomain });
  } catch (err) {
    showStatus(
      elements.captureStatus,
      "error",
      err.message || "Failed to save session.",
    );
  } finally {
    elements.saveBtn.disabled = false;
    elements.saveBtn.innerHTML = "Capture &amp; Send";
  }
}

// ---------------------------------------------------------------------------
// Copy JSON
// ---------------------------------------------------------------------------

async function handleCopyJson() {
  if (selectedCookieKeys.size === 0) return;

  // Build selected cookies as Dict[str, str] for easy paste into API calls
  const cookieDict = {};
  for (const cookie of currentCookies) {
    if (selectedCookieKeys.has(cookieKey(cookie))) {
      cookieDict[cookie.name] = cookie.value;
    }
  }

  try {
    await navigator.clipboard.writeText(JSON.stringify(cookieDict, null, 2));
    const origText = elements.copyBtn.textContent;
    elements.copyBtn.textContent = "Copied!";
    setTimeout(() => {
      elements.copyBtn.textContent = origText;
    }, 1500);
  } catch {
    // Fallback: select from a textarea
    const ta = document.createElement("textarea");
    ta.value = JSON.stringify(cookieDict, null, 2);
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    elements.copyBtn.textContent = "Copied!";
    setTimeout(() => {
      elements.copyBtn.textContent = "Copy";
    }, 1500);
  }
}

// ---------------------------------------------------------------------------
// Auth Cookie Detection
// ---------------------------------------------------------------------------

/**
 * Check if a cookie name matches known auth cookie patterns.
 */
function isAuthCookie(name) {
  return AUTH_COOKIE_PATTERNS.some((pattern) => pattern.test(name));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Unique key for a cookie (name + domain + path).
 */
function cookieKey(cookie) {
  return `${cookie.name}|${cookie.domain}|${cookie.path}`;
}

function showStatus(el, type, html) {
  el.className = `al-status al-status-${type}`;
  el.innerHTML = html;
  el.classList.remove("al-hidden");
}

function hideStatus(el) {
  el.className = "al-hidden";
  el.innerHTML = "";
}

function normalizeUrl(url) {
  // Strip trailing slash
  url = url.replace(/\/+$/, "");
  // Add https:// if missing
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  return url;
}

/**
 * Extract base domain from hostname.
 * e.g., "www.amazon.com" -> "amazon.com"
 *        "smile.amazon.co.uk" -> "amazon.co.uk"
 */
function getBaseDomain(hostname) {
  const parts = hostname.split(".");
  // Handle two-part TLDs like co.uk, com.au
  const twoPartTlds = [
    "co.uk",
    "co.jp",
    "co.kr",
    "co.in",
    "co.za",
    "com.au",
    "com.br",
    "com.cn",
    "com.mx",
    "com.tr",
    "org.uk",
    "net.au",
    "ac.uk",
  ];
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join(".");
    if (twoPartTlds.includes(lastTwo)) {
      return parts.slice(-3).join(".");
    }
  }
  if (parts.length >= 2) {
    return parts.slice(-2).join(".");
  }
  return hostname;
}
