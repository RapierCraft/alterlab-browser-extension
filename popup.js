/**
 * AlterLab Connect - Popup Script
 *
 * Handles cookie capture, selection, preview, and push to AlterLab
 * sessions API for BYOS (Bring Your Own Session) scraping.
 */

// DOM references
const elements = {
  authCheckView: document.getElementById("authCheckView"),
  keySelectorView: document.getElementById("keySelectorView"),
  keyList: document.getElementById("keyList"),
  keySelectorStatus: document.getElementById("keySelectorStatus"),
  loginView: document.getElementById("loginView"),
  loginBtn: document.getElementById("loginBtn"),
  signupLink: document.getElementById("signupLink"),
  useApiKeyBtn: document.getElementById("useApiKeyBtn"),
  hideApiKeyBtn: document.getElementById("hideApiKeyBtn"),
  apiKeyPanel: document.getElementById("apiKeyPanel"),
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
  selectAllBtn: document.getElementById("selectAllBtn"),
  selectNoneBtn: document.getElementById("selectNoneBtn"),
  selectAuthBtn: document.getElementById("selectAuthBtn"),
  selectedCount: document.getElementById("selectedCount"),
  versionBadge: document.getElementById("versionBadge"),
  openPanelBtn: document.getElementById("openPanelBtn"),
};

// State
let currentCookies = [];
let selectedCookieKeys = new Set();
let currentDomain = "";

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  // Set dynamic version from manifest
  try {
    const manifest = browser.runtime.getManifest();
    elements.versionBadge.textContent = `v${manifest.version}`;
  } catch {
    // Manifest unavailable — non-critical, continue
  }

  // Check for available updates and show banner
  checkUpdateBanner();

  bindEvents();
  bindAuthMessageListener();

  try {
    const config = await loadConfig();

    if (config.apiKey) {
      // Already configured — go straight to capture view
      await showCaptureView();
      return;
    }

    // No stored API key — check if user is logged in to AlterLab
    showAuthCheckView();

    try {
      const authResult = await browser.runtime.sendMessage({
        type: "CHECK_ALTERLAB_AUTH",
        apiUrl: config.apiUrl || ALTERLAB_DEFAULT_API_URL,
      });

      if (
        authResult &&
        authResult.authenticated &&
        authResult.hasApiKey &&
        authResult.keys
      ) {
        const keys = authResult.keys;
        const apiUrl = config.apiUrl || ALTERLAB_DEFAULT_API_URL;

        if (keys.length === 1) {
          // Single key — auto-select, decrypt, and configure
          await autoSelectKey(keys[0], apiUrl);
        } else {
          // Multiple keys — show selector
          showKeySelectorView(keys, apiUrl);
        }
      } else {
        // Not logged in or no API key — show login prompt
        showLoginView();
      }
    } catch {
      // Background check failed — show login prompt
      showLoginView();
    }
  } catch {
    // Storage or runtime error — show login as safe fallback
    showLoginView();
  }
});

function bindEvents() {
  elements.saveKeyBtn.addEventListener("click", handleSaveKey);
  elements.saveBtn.addEventListener("click", handleSaveToAlterLab);
  elements.copyBtn.addEventListener("click", handleCopyJson);
  elements.settingsBtn.addEventListener("click", () => showLoginView());
  elements.selectAllBtn.addEventListener("click", handleSelectAll);
  elements.selectNoneBtn.addEventListener("click", handleSelectNone);
  elements.selectAuthBtn.addEventListener("click", handleSelectAuth);

  // Login / signup buttons
  if (elements.loginBtn) {
    elements.loginBtn.addEventListener("click", handleLogin);
  }
  if (elements.signupLink) {
    elements.signupLink.addEventListener("click", (e) => {
      e.preventDefault();
      handleSignup();
    });
  }

  // API key panel toggle
  if (elements.useApiKeyBtn) {
    elements.useApiKeyBtn.addEventListener("click", () => {
      if (elements.apiKeyPanel) {
        elements.apiKeyPanel.classList.remove("al-hidden");
        elements.useApiKeyBtn.classList.add("al-hidden");
        if (elements.apiKeyInput) elements.apiKeyInput.focus();
      }
    });
  }
  if (elements.hideApiKeyBtn) {
    elements.hideApiKeyBtn.addEventListener("click", () => {
      if (elements.apiKeyPanel) {
        elements.apiKeyPanel.classList.add("al-hidden");
      }
      if (elements.useApiKeyBtn) {
        elements.useApiKeyBtn.classList.remove("al-hidden");
      }
    });
  }

  // Open side panel button
  if (elements.openPanelBtn) {
    elements.openPanelBtn.addEventListener("click", handleOpenPanel);
  }

  // Allow Enter key in API key input
  elements.apiKeyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSaveKey();
  });
}

// ---------------------------------------------------------------------------
// Auth message listener — background.js notifies on login/logout detection
// ---------------------------------------------------------------------------

function bindAuthMessageListener() {
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "CONFIG_UPDATED") {
      // Background auto-configured after login detection — refresh popup
      showCaptureView();
    }

    if (message.type === "AUTH_STATUS_CHANGED") {
      if (message.authenticated === false) {
        // User logged out — refresh to re-check state
        showLoginView();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function hideAllViews() {
  elements.authCheckView.classList.add("al-hidden");
  elements.keySelectorView.classList.add("al-hidden");
  elements.loginView.classList.add("al-hidden");
  elements.captureView.classList.add("al-hidden");
}

function showAuthCheckView() {
  hideAllViews();
  elements.authCheckView.classList.remove("al-hidden");
}

function showLoginView() {
  hideAllViews();
  elements.loginView.classList.remove("al-hidden");

  // Pre-fill manual setup with saved values
  loadConfig().then((config) => {
    if (config.apiKey) {
      elements.apiKeyInput.value = config.apiKey;
    }
    elements.apiUrlInput.value = config.apiUrl || ALTERLAB_DEFAULT_API_URL;
  });
}

async function showCaptureView() {
  hideAllViews();
  elements.captureView.classList.remove("al-hidden");
  hideStatus(elements.captureStatus);

  await captureCookies();
}

// ---------------------------------------------------------------------------
// Key Selector
// ---------------------------------------------------------------------------

/**
 * Auto-select a single key: decrypt it and save to config.
 * Used when the user has exactly one API key.
 */
async function autoSelectKey(keyInfo, apiUrl) {
  const result = await browser.runtime.sendMessage({
    type: "DECRYPT_API_KEY",
    apiUrl,
    keyId: keyInfo.id,
  });

  if (result && result.key) {
    await saveConfig(result.key, apiUrl);
    browser.runtime.sendMessage({ type: "CONFIG_UPDATED" });
    await showCaptureView();
  } else {
    // Decryption failed — fall back to login view with error
    showLoginView();
  }
}

/**
 * Show the key selector view with a list of API keys to choose from.
 * Each key is rendered as a clickable card showing name + masked prefix.
 */
function showKeySelectorView(keys, apiUrl) {
  hideAllViews();
  elements.keySelectorView.classList.remove("al-hidden");
  hideStatus(elements.keySelectorStatus);

  elements.keyList.innerHTML = "";

  for (const key of keys) {
    const item = document.createElement("div");
    item.className = "al-key-item";

    const info = document.createElement("div");
    info.className = "al-key-item-info";

    const name = document.createElement("div");
    name.className = "al-key-item-name";
    name.textContent = key.name || "Unnamed Key";

    const prefix = document.createElement("div");
    prefix.className = "al-key-item-prefix";
    prefix.textContent = key.keyPrefix ? `${key.keyPrefix}...` : "sk_live_...";

    info.appendChild(name);
    info.appendChild(prefix);

    // Show request count as meta info
    if (key.requests > 0) {
      const meta = document.createElement("div");
      meta.className = "al-key-item-meta";
      meta.textContent = `${key.requests.toLocaleString()} requests`;
      info.appendChild(meta);
    }

    // Chevron-right arrow (Lucide)
    const arrow = document.createElement("span");
    arrow.className = "al-key-item-arrow";
    arrow.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

    item.appendChild(info);
    item.appendChild(arrow);

    item.addEventListener("click", () => handleKeySelect(key, apiUrl));

    elements.keyList.appendChild(item);
  }
}

/**
 * Handle clicking a key in the selector: decrypt it and configure the extension.
 */
async function handleKeySelect(keyInfo, apiUrl) {
  // Show loading state on the selected item
  const items = elements.keyList.querySelectorAll(".al-key-item");
  for (const item of items) {
    item.style.pointerEvents = "none";
    item.style.opacity = "0.5";
  }

  showStatus(
    elements.keySelectorStatus,
    "info",
    '<span class="al-spinner al-spinner-sm"></span> Activating key...',
  );

  try {
    const result = await browser.runtime.sendMessage({
      type: "DECRYPT_API_KEY",
      apiUrl,
      keyId: keyInfo.id,
    });

    if (result && result.key) {
      await saveConfig(result.key, apiUrl);
      browser.runtime.sendMessage({ type: "CONFIG_UPDATED" });
      await showCaptureView();
    } else {
      showStatus(
        elements.keySelectorStatus,
        "error",
        result?.error || "Failed to activate key.",
      );
      // Re-enable items
      for (const item of items) {
        item.style.pointerEvents = "";
        item.style.opacity = "";
      }
    }
  } catch (err) {
    showStatus(
      elements.keySelectorStatus,
      "error",
      err.message || "Failed to activate key.",
    );
    for (const item of items) {
      item.style.pointerEvents = "";
      item.style.opacity = "";
    }
  }
}

// ---------------------------------------------------------------------------
// Login / Signup
// ---------------------------------------------------------------------------

function handleLogin() {
  const apiUrl = elements.apiUrlInput
    ? elements.apiUrlInput.value.trim()
    : ALTERLAB_DEFAULT_API_URL;
  const baseUrl = normalizeUrl(apiUrl || ALTERLAB_DEFAULT_API_URL);

  // Show loading state while tab opens
  if (elements.loginBtn) {
    const defaultLabel = elements.loginBtn.querySelector(".al-auth-btn-default");
    const loadingLabel = elements.loginBtn.querySelector(".al-auth-btn-loading");
    if (defaultLabel) defaultLabel.classList.add("al-hidden");
    if (loadingLabel) loadingLabel.classList.remove("al-hidden");
    elements.loginBtn.disabled = true;
  }

  browser.tabs.create({
    url: `${baseUrl}/signin?source=extension`,
    active: true,
  });
  // Close popup — when user comes back, the next popup open will re-check auth
  window.close();
}

function handleSignup() {
  const apiUrl = elements.apiUrlInput
    ? elements.apiUrlInput.value.trim()
    : ALTERLAB_DEFAULT_API_URL;
  const baseUrl = normalizeUrl(apiUrl || ALTERLAB_DEFAULT_API_URL);
  browser.tabs.create({
    url: `${baseUrl}/register?source=extension`,
    active: true,
  });
  window.close();
}

// ---------------------------------------------------------------------------
// Side Panel
// ---------------------------------------------------------------------------

async function handleOpenPanel() {
  try {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) return;

    if (browser.sidePanel) {
      // Chrome: native side panel
      await browser.sidePanel.open({ windowId: tab.windowId });
    } else {
      // Firefox fallback: delegate to background script which manages the
      // detached popup window lifecycle
      await browser.runtime.sendMessage({
        type: "OPEN_SIDE_PANEL",
        windowId: tab.windowId,
      });
    }
    window.close();
  } catch {
    // Silently fail — side panel / popup may not be available
  }
}

// ---------------------------------------------------------------------------
// API Key Setup
// ---------------------------------------------------------------------------

async function handleSaveKey() {
  const apiKey = elements.apiKeyInput.value.trim();
  const apiUrl = elements.apiUrlInput.value.trim() || ALTERLAB_DEFAULT_API_URL;

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
  elements.saveKeyBtn.innerHTML =
    '<span class="al-spinner al-spinner-sm al-spinner-white"></span>';

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
    browser.runtime.sendMessage({ type: "CONFIG_UPDATED" });

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
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab || !tab.url) {
      elements.domainBadge.textContent = "No tab";
      elements.cookieCount.textContent = "Cannot read this page";
      return;
    }

    const url = new URL(tab.url);

    // chrome:// and extension pages don't have cookies
    if (
      !url.hostname ||
      url.protocol === "chrome:" ||
      url.protocol === "chrome-extension:"
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
    const cookies = await browser.cookies.getAll({ domain: baseDomain });

    // Also get cookies set on the exact hostname (some are set without leading dot)
    const exactCookies = await browser.cookies.getAll({ url: tab.url });

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

    // Render cookie list with card-based groups
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
    empty.className = "al-empty";
    empty.innerHTML = `
      <svg class="al-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
      <p class="al-empty-title">No cookies found</p>
      <p class="al-empty-description">This domain has no cookies to capture.</p>
    `;
    elements.cookieList.appendChild(empty);
    return;
  }

  // Split cookies into auth and other groups
  const authCookies = currentCookies.filter((c) => isAuthCookie(c.name));
  const otherCookies = currentCookies.filter((c) => !isAuthCookie(c.name));

  // Render auth group
  if (authCookies.length > 0) {
    renderCookieGroup(
      "Auth & Session",
      authCookies,
      "accent",
      // Shield icon (Lucide)
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>',
    );
  }

  // Render other group
  if (otherCookies.length > 0) {
    renderCookieGroup(
      "Other",
      otherCookies,
      "muted",
      // Cookie icon (Lucide)
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17v.01"/><path d="M7 14v.01"/></svg>',
    );
  }
}

/**
 * Render a group of cookies inside a card with a header.
 */
function renderCookieGroup(title, cookies, colorVariant, iconSvg) {
  const group = document.createElement("div");
  group.className = "al-cookie-group";

  // Group header
  const header = document.createElement("div");
  header.className = "al-cookie-group-header";

  const titleEl = document.createElement("span");
  titleEl.className = "al-cookie-group-title";

  const iconSpan = document.createElement("span");
  iconSpan.className = "al-cookie-group-icon";
  iconSpan.style.color =
    colorVariant === "accent"
      ? "var(--al-accent-text)"
      : "var(--al-text-muted)";
  iconSpan.innerHTML = iconSvg;

  titleEl.appendChild(iconSpan);
  titleEl.appendChild(document.createTextNode(title));

  const countEl = document.createElement("span");
  countEl.className = "al-cookie-group-count";
  countEl.textContent = `${cookies.length}`;

  header.appendChild(titleEl);
  header.appendChild(countEl);
  group.appendChild(header);

  // Cookie list inside card
  const list = document.createElement("div");
  list.className = "al-list al-list-scrollable";
  if (cookies.length > 8) {
    list.style.maxHeight = "160px";
  }

  for (const cookie of cookies) {
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
    name.className = "al-list-item-name";
    if (isAuth) {
      name.style.color = "var(--al-accent-text)";
    }
    name.textContent = cookie.name;
    name.title = `${cookie.name} (${cookie.domain})`;

    const flags = document.createElement("span");
    flags.className = "al-list-item-meta";

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

    list.appendChild(item);
  }

  group.appendChild(list);
  elements.cookieList.appendChild(group);
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
    showLoginView();
    return;
  }

  const sessionName = elements.sessionName.value.trim() || currentDomain;

  elements.saveBtn.disabled = true;
  elements.saveBtn.innerHTML =
    '<span class="al-spinner al-spinner-sm al-spinner-white"></span> Saving...';
  hideStatus(elements.captureStatus);

  try {
    // Build cookies as Dict[str, str] (name -> value) matching SessionCreate schema
    const cookieDict = {};
    for (const cookie of currentCookies) {
      if (selectedCookieKeys.has(cookieKey(cookie))) {
        cookieDict[cookie.name] = cookie.value;
      }
    }

    const body = {
      domain: currentDomain,
      name: sessionName,
      cookies: cookieDict,
      consent: true,
    };

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
    browser.runtime.sendMessage({
      type: "SESSION_SAVED",
      domain: currentDomain,
    });
  } catch (err) {
    showStatus(
      elements.captureStatus,
      "error",
      err.message || "Failed to save session.",
    );
  } finally {
    elements.saveBtn.disabled = false;
    elements.saveBtn.innerHTML = `
      <svg style="width: 14px; height: 14px; margin-right: 2px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      Capture &amp; Send
    `;
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
    animateCopyCheck(elements.copyBtn);
  } catch {
    // Fallback: select from a textarea
    const ta = document.createElement("textarea");
    ta.value = JSON.stringify(cookieDict, null, 2);
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    animateCopyCheck(elements.copyBtn);
  }
}

// ---------------------------------------------------------------------------
// Copy Feedback Animation
// ---------------------------------------------------------------------------

/**
 * Animate a copy button — show checkmark icon briefly, then revert.
 * Works with buttons that have .al-btn-label and .al-copy-check children.
 */
function animateCopyCheck(btn) {
  if (!btn || btn.classList.contains("al-copied")) return;
  btn.classList.add("al-copied");
  setTimeout(() => {
    btn.classList.remove("al-copied");
  }, 1500);
}

/**
 * Check for stored update info from background script and show banner.
 * Also listens for UPDATE_AVAILABLE messages from the background script
 * in case an update is detected while the popup is open.
 */
async function checkUpdateBanner() {
  const banner = document.getElementById("updateBanner");
  const versionEl = document.getElementById("updateVersion");
  const linkEl = document.getElementById("updateLink");
  if (!banner || !versionEl || !linkEl) return;

  function showBanner(latest, download) {
    versionEl.textContent = `v${latest}`;
    // Detect browser for the right download link
    const isFirefox =
      typeof browser !== "undefined" &&
      typeof browser.runtime.getBrowserInfo === "function";
    const url = isFirefox ? download?.firefox : download?.chrome;
    linkEl.href = url || download?.chrome || "#";
    banner.classList.remove("al-hidden");
  }

  try {
    const result = await browser.storage.local.get("updateAvailable");
    if (result.updateAvailable) {
      showBanner(
        result.updateAvailable.latest,
        result.updateAvailable.download,
      );
    }
  } catch {
    // Non-critical — banner just won't show
  }

  // Listen for live update notifications from background
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "UPDATE_AVAILABLE") {
      showBanner(message.latest, message.download);
    }
  });
}
