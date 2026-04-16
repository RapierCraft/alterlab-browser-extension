/**
 * AlterLab Connect - Background Script
 *
 * Runs as a service worker on Chrome MV3 and as an event page on Firefox.
 * Both environments are ephemeral — in-memory state is lost when the
 * script unloads. Use browser.storage for anything that must persist.
 *
 * Orchestrates:
 * - Side panel lifecycle
 * - Badge management (scrape complexity score)
 * - Context menu creation ("Scrape this element", "Copy selector")
 * - Message routing between popup, side panel, and content scripts
 */

// In Chrome service workers, dependencies must be loaded via importScripts().
// In Firefox event pages, the manifest "scripts" array loads them automatically.
// Detect the environment and only call importScripts() when running as a
// service worker to avoid double-loading.
if (
  typeof ServiceWorkerGlobalScope !== "undefined" &&
  self instanceof ServiceWorkerGlobalScope
) {
  importScripts("browser-polyfill.min.js", "shared.js");
}

const BADGE_ALARM_NAME = "alterlab-badge-refresh";
const BADGE_REFRESH_MINUTES = 30;
const SESSION_STALENESS_ALARM = "alterlab-session-staleness";
const SESSION_STALENESS_MINUTES = 60;
const UPDATE_CHECK_ALARM = "alterlab-update-check";
const UPDATE_CHECK_MINUTES = 24 * 60; // 24 hours
const VERSION_API_URL = "https://alterlab.io/api/extension/version";

// ---------------------------------------------------------------------------
// Side panel fallback — Chrome uses browser.sidePanel, Firefox uses a
// detached popup window that loads the same sidepanel.html.
// ---------------------------------------------------------------------------

const HAS_SIDE_PANEL = typeof browser !== "undefined" && !!browser.sidePanel;

// Tracks the detached popup window ID when running on Firefox (fallback mode).
// Persisted via browser.storage.session so it survives event page unloads.
// In Chrome service workers, in-memory state is equally ephemeral, so we
// persist there too — the storage.session API is available in both MV3 runtimes.
let panelWindowId = null;

// Promise that resolves once the persisted panelWindowId has been loaded from
// storage. openSidePanel() awaits this before acting so that a user click
// immediately after script load does not race against the async restore and
// incorrectly create a second window.
let panelWindowIdReady;

/**
 * Read persisted panelWindowId from session storage on startup.
 * Called once when the background script loads (or reloads after suspend).
 * Returns a promise so callers can await full initialisation.
 */
async function restorePanelWindowId() {
  try {
    // browser.storage.session is MV3-only (Chrome 102+, Firefox 115+).
    // Older Firefox versions won't have it — fall back gracefully.
    if (browser.storage.session) {
      const result = await browser.storage.session.get("panelWindowId");
      if (typeof result.panelWindowId === "number") {
        // Verify the window still exists before trusting the stored ID
        try {
          await browser.windows.get(result.panelWindowId);
          panelWindowId = result.panelWindowId;
        } catch {
          // Window was closed while we were suspended — clear stale ID
          panelWindowId = null;
          await browser.storage.session.remove("panelWindowId");
        }
      }
    }
  } catch {
    // storage.session not available — panelWindowId stays null (safe default)
  }
}

/**
 * Persist panelWindowId to session storage.
 * @param {number|null} id - window ID to persist, or null to clear
 */
async function persistPanelWindowId(id) {
  panelWindowId = id;
  try {
    if (browser.storage.session) {
      if (id !== null) {
        await browser.storage.session.set({ panelWindowId: id });
      } else {
        await browser.storage.session.remove("panelWindowId");
      }
    }
  } catch {
    // storage.session not available — memory-only (best effort)
  }
}

// Restore panelWindowId immediately on script load and capture the promise so
// openSidePanel() can wait for it to complete before checking panelWindowId.
panelWindowIdReady = restorePanelWindowId();

/**
 * Open the side panel UI.  On Chrome this uses the native sidePanel API.
 * On Firefox (and any browser without sidePanel) it opens sidepanel.html
 * as a detached popup window, reusing the existing one if still open.
 *
 * @param {number} windowId  The browser window to associate with.
 * @returns {Promise<void>}
 */
async function openSidePanel(windowId) {
  if (HAS_SIDE_PANEL) {
    await browser.sidePanel.open({ windowId });
    return;
  }

  // Wait for the async storage restore to finish before reading panelWindowId.
  // Without this await a user action fired immediately after script load races
  // against restorePanelWindowId() and always sees panelWindowId === null,
  // causing a duplicate window to be created on every script wake-up.
  await panelWindowIdReady;

  // Fallback: reuse existing popup window if it's still open.
  // Use typeof guard so that both null and undefined are treated as "no window".
  if (typeof panelWindowId === "number") {
    try {
      const existing = await browser.windows.get(panelWindowId);
      if (existing) {
        await browser.windows.update(panelWindowId, { focused: true });
        return;
      }
    } catch {
      // Window was closed — fall through to create a new one
      await persistPanelWindowId(null);
    }
  }

  const win = await browser.windows.create({
    url: browser.runtime.getURL("sidepanel.html"),
    type: "popup",
    width: 420,
    height: 800,
  });
  await persistPanelWindowId(win.id);
}

// Clean up tracked window ID when the popup panel is closed.
// Using typeof guard: panelWindowId is only ever set to a number or null,
// but the guard makes the intent explicit and prevents a stale null from
// accidentally matching if the comparison semantics ever change.
browser.windows.onRemoved.addListener((closedWindowId) => {
  if (typeof panelWindowId === "number" && closedWindowId === panelWindowId) {
    persistPanelWindowId(null);
  }
});

// Per-tab storage for security header signals detected via webRequest
const tabHeaderSignals = new Map();

// Per-tab storage for raw response headers (used by content script anti-bot detection)
const tabResponseHeaders = new Map();

// Per-tab ring buffer for network request/response headers (Headers tab)
const MAX_REQUESTS_PER_TAB = 200;
const tabNetworkRequests = new Map(); // tabId -> { requests: [], pending: Map }

// ---------------------------------------------------------------------------
// Cross-browser helpers
// ---------------------------------------------------------------------------

/**
 * Detect Firefox at runtime. Firefox exposes browser.runtime.getBrowserInfo()
 * which Chrome does not have. This is more reliable than user-agent sniffing
 * in a service worker context.
 */
const IS_FIREFOX =
  typeof browser !== "undefined" &&
  typeof browser.runtime.getBrowserInfo === "function";

/**
 * Capture a screenshot of the specified tab, handling the API difference
 * between Chrome (captureVisibleTab) and Firefox (captureTab).
 *
 * Chrome: browser.tabs.captureVisibleTab(windowId, options) — captures the
 *   visible area of the active tab in the given window.
 * Firefox: browser.tabs.captureTab(tabId, options) — captures the visible
 *   area of the specified tab. captureVisibleTab does NOT exist on Firefox.
 *
 * @param {number} tabId - ID of the tab to capture
 * @param {number} windowId - ID of the window (used by Chrome path)
 * @param {object} [options] - capture options (format, quality)
 * @returns {Promise<string>} data URL of the screenshot
 */
async function captureScreenshot(tabId, windowId, options = {}) {
  if (IS_FIREFOX || typeof browser.tabs.captureTab === "function") {
    // Firefox path — captureTab takes a tabId
    return browser.tabs.captureTab(tabId, options);
  }
  // Chrome path — captureVisibleTab takes a windowId
  return browser.tabs.captureVisibleTab(windowId, options);
}

/**
 * Build the options array for webRequest listeners, conditionally including
 * "extraHeaders" only on Chrome.
 *
 * Firefox does NOT support the "extraHeaders" option — it exposes all headers
 * (including CORS/security headers) by default. Passing "extraHeaders" on
 * Firefox triggers a warning or error.
 *
 * Chrome requires "extraHeaders" (since Chrome 72) to access certain headers
 * like Set-Cookie, Referer, and CORS headers in onHeadersReceived.
 *
 * @param {...string} baseOptions - base listener options (e.g. "responseHeaders", "requestHeaders")
 * @returns {string[]} options array with "extraHeaders" appended on Chrome only
 */
function webRequestOptions(...baseOptions) {
  if (!IS_FIREFOX) {
    baseOptions.push("extraHeaders");
  }
  return baseOptions;
}

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    console.log("[AlterLab] Extension installed.");
    browser.action.setBadgeBackgroundColor({ color: "#6366f1" });

    // Guard: only open welcome tab once (Firefox temporary add-ons
    // re-fire onInstalled on every load from about:debugging)
    const { welcomeTabOpened } = await browser.storage.local.get("welcomeTabOpened");
    if (!welcomeTabOpened) {
      browser.storage.local.set({
        firstRunComplete: false,
        hasSeenOverlay: false,
        welcomeTabOpened: true,
      });
      browser.tabs.create({
        url: "https://alterlab.io/welcome?source=extension",
        active: true,
      });
    }
  } else if (details.reason === "update") {
    console.log(
      `[AlterLab] Extension updated to v${browser.runtime.getManifest().version}`,
    );
  }

  // Set up periodic badge refresh
  browser.alarms.create(BADGE_ALARM_NAME, {
    periodInMinutes: BADGE_REFRESH_MINUTES,
  });

  // Set up periodic session staleness check
  browser.alarms.create(SESSION_STALENESS_ALARM, {
    periodInMinutes: SESSION_STALENESS_MINUTES,
  });

  // Set up periodic update check (Firefox — Chrome uses native update_url)
  browser.alarms.create(UPDATE_CHECK_ALARM, {
    delayInMinutes: 1, // Check shortly after install/update
    periodInMinutes: UPDATE_CHECK_MINUTES,
  });

  // Create context menus
  createContextMenus();

  // Enable side panel (Chrome-only API — Firefox uses popup fallback)
  if (HAS_SIDE_PANEL) {
    browser.sidePanel
      .setOptions({
        enabled: true,
      })
      .catch(() => {
        // Side panel API might not be available in older Chrome
      });
  }
});

// ---------------------------------------------------------------------------
// Extension icon click → open side panel
// ---------------------------------------------------------------------------

browser.action.onClicked.addListener(async (tab) => {
  try {
    await openSidePanel(tab.windowId);
  } catch (err) {
    console.error("[AlterLab] Failed to open side panel:", err);
  }
});

// ---------------------------------------------------------------------------
// Context Menus
// ---------------------------------------------------------------------------

async function createContextMenus() {
  // Remove existing menus first to avoid duplicates
  await browser.contextMenus.removeAll();

  browser.contextMenus.create({
    id: "alterlab-scrape-element",
    title: "Scrape this element",
    contexts: ["all"],
  });

  browser.contextMenus.create({
    id: "alterlab-copy-selector",
    title: "Copy selector",
    contexts: ["all"],
  });

  browser.contextMenus.create({
    id: "alterlab-separator",
    type: "separator",
    contexts: ["all"],
  });

  browser.contextMenus.create({
    id: "alterlab-open-sidepanel",
    title: "Open AlterLab Connect",
    contexts: ["all"],
  });
}

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "alterlab-open-sidepanel") {
    try {
      await openSidePanel(tab.windowId);
    } catch {
      // Panel may already be open
    }
    return;
  }

  if (info.menuItemId === "alterlab-scrape-element") {
    // Send message to content script to get the clicked element's selector
    try {
      const response = await browser.tabs.sendMessage(tab.id, {
        type: "GET_ELEMENT_SELECTOR",
      });
      if (response && response.selector) {
        // Store selector for side panel Job tab to use
        await browser.storage.local.set({
          lastElementSelector: response.selector,
          lastElementUrl: tab.url,
        });
        // Open side panel on Job tab
        await browser.storage.local.set({ sidepanelOpenTab: "job" });
        await openSidePanel(tab.windowId);
      }
    } catch {
      // Content script not available on this page
    }
    return;
  }

  if (info.menuItemId === "alterlab-copy-selector") {
    try {
      // Inject a small script to copy the element under cursor
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // This runs in the page context — gets the last right-clicked element
          const el = document.querySelector(":hover");
          if (!el) return;

          function getSelector(element) {
            if (element.id) return `#${element.id}`;
            let path = "";
            let current = element;
            while (current && current !== document.body) {
              let sel = current.tagName.toLowerCase();
              if (current.className && typeof current.className === "string") {
                const cls = current.className
                  .trim()
                  .split(/\s+/)
                  .filter((c) => c.length > 0 && !c.includes(":"))
                  .slice(0, 2)
                  .join(".");
                if (cls) sel += "." + cls;
              }
              path = path ? sel + " > " + path : sel;
              current = current.parentElement;
            }
            return path;
          }

          const selector = getSelector(el);
          navigator.clipboard.writeText(selector).catch(() => {
            // Fallback
            const ta = document.createElement("textarea");
            ta.value = selector;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
          });
        },
      });
    } catch {
      // Cannot execute on this page
    }
    return;
  }
});

// ---------------------------------------------------------------------------
// Dashboard bridge handler
// ---------------------------------------------------------------------------

/**
 * Handle a DASHBOARD_REQUEST forwarded from the content script bridge.
 * Routes by `action` field to existing handler logic.
 *
 * @param {Object} message - { action, payload, correlationId }
 * @returns {Promise<Object>} - { ...data } on success, { error: string } on failure
 */
async function handleDashboardRequest(message) {
  const { action, payload } = message;

  try {
    switch (action) {
      case "GET_COOKIES": {
        // Reuse existing cookie capture infrastructure
        const domain = payload.domain;
        if (!domain) return { error: "Missing domain in payload" };
        return await handleGetCookies(domain, payload.url || null);
      }

      case "CAPTURE_NOW": {
        // Capture cookies from the currently active tab's domain
        const tabs = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tabs.length || !tabs[0].url) {
          return { error: "No active tab found" };
        }
        const tabUrl = new URL(tabs[0].url);
        const domain = payload.domain || tabUrl.hostname;
        return await handleGetCookies(domain, tabs[0].url);
      }

      case "GET_STATUS": {
        // Return extension status, version, active tab info, and config state
        const manifest = browser.runtime.getManifest();
        const config = await loadConfig();
        const activeTabs = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        const activeTab = activeTabs.length > 0 ? activeTabs[0] : null;
        return {
          version: manifest.version,
          active: true,
          configured: !!config.apiKey,
          activeTab: activeTab
            ? {
                url: activeTab.url || null,
                title: activeTab.title || null,
                domain: activeTab.url
                  ? new URL(activeTab.url).hostname
                  : null,
              }
            : null,
        };
      }

      case "SEND_API_KEY": {
        // Welcome page sends the user's API key after sign-in
        const { apiKey, apiUrl } = payload || {};
        if (!apiKey || typeof apiKey !== "string" || !apiKey.startsWith("sk_live_")) {
          return { error: "Invalid API key format" };
        }
        await saveConfig(apiKey, apiUrl || null);
        // Notify any open side panels / popups
        try {
          await browser.runtime.sendMessage({ type: "CONFIG_UPDATED" });
        } catch (_) {
          // No listeners — fine
        }
        return { success: true };
      }

      default:
        return { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { error: err.message || "Dashboard request failed" };
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CHECK_ALTERLAB_AUTH") {
    handleCheckAlterLabAuth(message.apiUrl).then(sendResponse);
    return true; // async response
  }

  if (message.type === "DECRYPT_API_KEY") {
    handleDecryptApiKey(message.apiUrl, message.keyId).then(sendResponse);
    return true; // async response
  }

  if (message.type === "OPEN_SIDE_PANEL") {
    // Popup delegates panel opening to background (owns the fallback window lifecycle)
    openSidePanel(message.windowId)
      .then(() => sendResponse({ status: "ok" }))
      .catch((err) => sendResponse({ status: "error", error: err.message }));
    return true; // async response
  }

  if (message.type === "GET_COOKIES") {
    handleGetCookies(message.domain, message.url).then(sendResponse);
    return true; // async response
  }

  if (message.type === "CAPTURE_COOKIES_FOR_DASHBOARD") {
    // Dashboard cookie bridge — reuses existing handleGetCookies infrastructure
    handleGetCookies(message.domain, null).then(sendResponse);
    return true; // async response
  }

  if (message.type === "BADGE_LOADING") {
    // Show "..." while page analysis is in progress
    browser.action.setBadgeText({ text: "..." });
    browser.action.setBadgeBackgroundColor({ color: "#44403c" }); // muted grey
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "BADGE_ERROR") {
    // Show "!" when analysis fails
    browser.action.setBadgeText({ text: "!" });
    browser.action.setBadgeBackgroundColor({ color: "#ef4444" }); // error red
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "SCRAPE_SCORE") {
    // Store score and update badge
    const score = message.score;
    const domain = message.domain;
    if (typeof score === "number" && domain) {
      browser.storage.local.set({ ["scrapeScore_" + domain]: score });
      updateBadgeWithScore(score);
    }
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "CONTENT_SCRIPT_READY") {
    // Content script loaded — request analysis with retry for race conditions
    if (sender.tab && sender.tab.id) {
      requestAnalysisWithRetry(sender.tab.id, sender.tab.active);

      // First page visit after install — auto-open side panel to show score
      browser.storage.local.get(["firstRunComplete"]).then((result) => {
        if (result.firstRunComplete === false) {
          browser.storage.local.set({ firstRunComplete: true });
          // Small delay so the page loads and score computes first
          setTimeout(() => {
            openSidePanel(sender.tab.windowId).catch(() => {
              // Side panel / popup may not be available
            });
          }, 1500);
        }
      });
    }
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "GET_HEADER_SIGNALS") {
    // Side panel requests header signals collected via webRequest
    const signals = tabHeaderSignals.get(message.tabId) || [];
    sendResponse({ signals });
    return false;
  }

  if (message.type === "GET_RESPONSE_HEADERS") {
    // Side panel requests raw response headers for anti-bot detection
    const headers = tabResponseHeaders.get(message.tabId) || null;
    sendResponse({ headers });
    return false;
  }

  if (message.type === "FETCH_URL") {
    handleFetchUrl(message.url)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message, body: null }));
    return true; // async response
  }

  if (message.type === "GET_NETWORK_REQUESTS") {
    // Side panel requests captured network headers for a tab
    const tabData = tabNetworkRequests.get(message.tabId);
    sendResponse({ requests: tabData ? tabData.requests : [] });
    return false;
  }

  if (message.type === "CLEAR_NETWORK_REQUESTS") {
    // Side panel requests clearing the buffer for a tab
    tabNetworkRequests.delete(message.tabId);
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "NETWORK_REQUEST") {
    // Content script forwards page-context XHR/fetch interception data.
    // entry fields: id, method, url, status, statusText, contentType,
    //   responseSize, responseTime, body, dataType, timestamp, source
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null && tabId >= 0) {
      let tabData = tabNetworkRequests.get(tabId);
      if (!tabData) {
        tabData = { requests: [], pending: new Map() };
        tabNetworkRequests.set(tabId, tabData);
      }

      const entry = message.entry;
      if (entry) {
        // Normalise to the same shape as webRequest entries so the sidepanel
        // can render them uniformly. Mark source so the panel can indicate
        // this came from the page-context interceptor (has response body).
        const normalisedEntry = {
          requestId: entry.id || String(entry.timestamp),
          url: entry.url || "",
          method: entry.method || "GET",
          type: entry.dataType || "other",
          timestamp: entry.timestamp || Date.now(),
          requestHeaders: [],
          responseHeaders: [],
          statusCode: entry.status || 0,
          statusLine: entry.statusText || "",
          duration: entry.responseTime || 0,
          contentType: entry.contentType || "",
          responseSize: entry.responseSize || 0,
          body: entry.body || "",
          dataType: entry.dataType || null,
          source: entry.source || "content",
        };

        tabData.requests.push(normalisedEntry);
        if (tabData.requests.length > MAX_REQUESTS_PER_TAB) {
          tabData.requests.shift();
        }

        // Notify side panel so the network tab updates live
        notifySidePanels({
          type: "NETWORK_REQUEST_ADDED",
          tabId,
          entry: normalisedEntry,
        });
      }
    }
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "SESSION_SAVED" || message.type === "CONFIG_UPDATED") {
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "SESSION_PROFILE_COUNT") {
    // Update badge with local session profile count for the active domain
    const count = message.count || 0;
    if (count > 0) {
      browser.action.setBadgeText({ text: String(count) });
      browser.action.setBadgeBackgroundColor({ color: "#6366f1" });
    }
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "CONNECTIVITY_RESTORED") {
    replaySyncQueue();
    sendResponse({ status: "ok" });
    return false;
  }

  if (
    message.type === "SELECTOR_PICKED" ||
    message.type === "SELECTOR_ESCAPED"
  ) {
    // Forward from content script to side panel
    notifySidePanels(message);
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "PING") {
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "SCRAPE_PAGE") {
    handleScrapePage(message).then(sendResponse);
    return true; // async response
  }

  if (message.type === "CAPTURE_SCREENSHOT") {
    handleCaptureScreenshot().then(sendResponse);
    return true; // async response
  }

  // --- Generic dashboard bridge ---
  // Routes DASHBOARD_REQUEST messages from the content script bridge.
  // Each action maps to existing handler logic.
  if (message.type === "DASHBOARD_REQUEST") {
    handleDashboardRequest(message).then(sendResponse);
    return true; // async response
  }
});

// ---------------------------------------------------------------------------
// Tab change — update badge for new tab
// ---------------------------------------------------------------------------

browser.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    if (tab && tab.url) {
      const url = new URL(tab.url);
      const domain = url.hostname;
      // Show cached score immediately, then trigger fresh analysis
      const result = await browser.storage.local.get(["scrapeScore_" + domain]);
      const score = result["scrapeScore_" + domain];
      if (typeof score === "number") {
        updateBadgeWithScore(score);
      } else {
        browser.action.setBadgeText({ text: "" });
      }
    } else {
      browser.action.setBadgeText({ text: "" });
    }
  } catch {
    browser.action.setBadgeText({ text: "" });
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Clear network requests on new navigation (before page loads)
  if (changeInfo.status === "loading" && tab.url) {
    tabNetworkRequests.set(tabId, { requests: [], pending: new Map() });
  }

  if (changeInfo.status === "loading" && tab.active && tab.url) {
    // Show "..." immediately when a page starts loading
    try {
      const url = new URL(tab.url);
      if (url.protocol === "http:" || url.protocol === "https:") {
        browser.action.setBadgeText({ text: "..." });
        browser.action.setBadgeBackgroundColor({ color: "#44403c" });
      }
    } catch {
      // ignore
    }
  }
  if (changeInfo.status === "complete" && tab.active && tab.url) {
    try {
      const url = new URL(tab.url);
      if (url.protocol === "http:" || url.protocol === "https:") {
        // Trigger fresh analysis on every completed page load
        requestAnalysisWithRetry(tabId, true);
      }
    } catch {
      browser.action.setBadgeText({ text: "" });
    }
  }
});

// Clean up header signals and network requests when tab is closed
browser.tabs.onRemoved.addListener((tabId) => {
  tabHeaderSignals.delete(tabId);
  tabResponseHeaders.delete(tabId);
  tabNetworkRequests.delete(tabId);
});

// ---------------------------------------------------------------------------
// Badge Management
// ---------------------------------------------------------------------------

// Track previous badge score for pulse animation
let lastBadgeScore = null;

function updateBadgeWithScore(score) {
  const color = scrapeScoreColor(score);
  browser.action.setBadgeText({ text: String(score) });
  browser.action.setBadgeBackgroundColor({ color });

  // Pulse effect: briefly flash badge when score changes between pages
  if (lastBadgeScore !== null && lastBadgeScore !== score) {
    browser.action.setBadgeBackgroundColor({ color: "#ffffff" });
    setTimeout(() => {
      browser.action.setBadgeBackgroundColor({ color });
    }, 150);
    setTimeout(() => {
      browser.action.setBadgeBackgroundColor({ color: "#ffffff" });
    }, 300);
    setTimeout(() => {
      browser.action.setBadgeBackgroundColor({ color });
    }, 450);
  }
  lastBadgeScore = score;
}

/**
 * Request page analysis from content script with retry logic.
 * The content script may not be ready immediately after navigation,
 * so we retry up to 3 times with exponential backoff.
 */
function requestAnalysisWithRetry(tabId, updateBadge, attempt = 0) {
  const MAX_ATTEMPTS = 3;
  const DELAY_MS = [200, 500, 1000]; // exponential backoff

  // Show "..." on first attempt (loading indicator)
  if (attempt === 0 && updateBadge) {
    browser.action.setBadgeText({ text: "..." });
    browser.action.setBadgeBackgroundColor({ color: "#44403c" });
  }

  browser.tabs
    .sendMessage(tabId, { type: "ANALYZE_PAGE" })
    .then((analysis) => {
      if (analysis && typeof analysis.score === "number") {
        // Merge header signals from webRequest into analysis
        const headerSignals = tabHeaderSignals.get(tabId) || [];
        let adjustedScore = analysis.score;

        for (const signal of headerSignals) {
          if (!analysis.signals.includes(signal.label)) {
            analysis.signals.push(signal.label);
            adjustedScore += signal.score;
          }
        }

        adjustedScore = Math.min(100, Math.max(0, adjustedScore));
        analysis.score = adjustedScore;

        // Store the enriched analysis
        browser.storage.local.set({
          ["scrapeScore_" + analysis.domain]: analysis.score,
          ["scrapeAnalysis_" + analysis.domain]: analysis,
        });

        if (updateBadge) {
          updateBadgeWithScore(analysis.score);
        }
      }
    })
    .catch(() => {
      // Content script not ready yet — retry with backoff
      if (attempt < MAX_ATTEMPTS) {
        setTimeout(() => {
          requestAnalysisWithRetry(tabId, updateBadge, attempt + 1);
        }, DELAY_MS[attempt] || 1000);
      } else if (updateBadge) {
        // All retries exhausted — show error state
        browser.action.setBadgeText({ text: "!" });
        browser.action.setBadgeBackgroundColor({ color: "#ef4444" });
      }
    });
}

// ---------------------------------------------------------------------------
// WebRequest Header Analysis
// ---------------------------------------------------------------------------

// Listen for response headers to detect server-side security signals.
// This runs in the background service worker and has access to HTTP headers
// that are invisible to content scripts.
if (browser.webRequest) {
  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      // Only analyze main frame (document) requests
      if (details.type !== "main_frame") return;

      const signals = [];
      const headers = details.responseHeaders || [];

      for (const header of headers) {
        const name = header.name.toLowerCase();
        const value = (header.value || "").toLowerCase();

        // Server header reveals stack
        if (name === "server") {
          if (value.includes("cloudflare")) {
            signals.push({ label: "Cloudflare CDN", score: 5 });
          } else if (value.includes("akamai") || value.includes("akamaghost")) {
            signals.push({ label: "Akamai CDN", score: 5 });
          }
        }

        // Strict security headers indicate sophistication
        if (name === "strict-transport-security" && value.includes("max-age")) {
          signals.push({ label: "HSTS enabled", score: 3 });
        }

        if (name === "content-security-policy" && value.length > 100) {
          signals.push({ label: "Strict CSP policy", score: 5 });
        }

        // X-Frame-Options / frame denial
        if (name === "x-frame-options") {
          signals.push({ label: "X-Frame-Options: " + header.value, score: 2 });
        }

        // WAF / security product headers
        if (name === "x-sucuri-id" || name === "x-sucuri-cache") {
          signals.push({ label: "Sucuri WAF", score: 10 });
        }

        if (name === "x-cdn" && value.includes("imperva")) {
          signals.push({ label: "Imperva CDN", score: 10 });
        }

        // Rate limiting headers
        if (name === "x-ratelimit-limit" || name === "x-rate-limit-limit") {
          signals.push({ label: "Rate limiting active", score: 5 });
        }

        // Bot detection cookies set via headers
        if (name === "set-cookie") {
          if (value.includes("datadome")) {
            signals.push({ label: "DataDome (cookie)", score: 10 });
          }
          if (value.includes("_abck") || value.includes("bm_sz")) {
            signals.push({ label: "Akamai Bot Manager (cookie)", score: 10 });
          }
          if (value.includes("_pxhd") || value.includes("_pxvid")) {
            signals.push({ label: "PerimeterX (cookie)", score: 10 });
          }
        }
      }

      if (signals.length > 0) {
        tabHeaderSignals.set(details.tabId, signals);
      }

      // Store raw response headers for content script anti-bot detection
      // (content scripts can't see HTTP headers directly)
      const headerMap = {};
      for (const h of headers) {
        headerMap[h.name.toLowerCase()] = h.value || "";
      }
      tabResponseHeaders.set(details.tabId, headerMap);

      // Inject headers into page context so content script can access them
      // via window.__alterlabHeaderCache
      if (details.tabId >= 0) {
        try {
          const scriptOpts = {
            target: { tabId: details.tabId },
            func: (headerData) => {
              window.__alterlabHeaderCache = headerData;
            },
            args: [headerMap],
          };
          // injectImmediately is Chrome-only (Chromium 102+). Firefox does not
          // support it and will throw if present. Only include on Chrome.
          if (!IS_FIREFOX) {
            scriptOpts.injectImmediately = true;
          }
          browser.scripting.executeScript(scriptOpts).catch(() => {
            // Can't inject into this page (chrome://, extensions, etc.)
          });
        } catch {
          // scripting API not available
        }
      }
    },
    { urls: ["<all_urls>"] },
    webRequestOptions("responseHeaders"),
  );

  // ---------------------------------------------------------------------------
  // Network Request Capture (Headers tab)
  // ---------------------------------------------------------------------------

  // Temporary storage for request bodies — onBeforeRequest fires before
  // onSendHeaders, so we stash the body here and merge it when the entry
  // is created in onSendHeaders.
  const pendingBodies = new Map(); // requestId -> string|null

  // Capture request body via onBeforeRequest (the ONLY event that exposes it)
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (!details.requestBody) return;

      let body = null;

      // Raw bytes (JSON, plain text, XML, etc.)
      if (details.requestBody.raw && details.requestBody.raw.length > 0) {
        try {
          const decoder = new TextDecoder("utf-8");
          const chunks = details.requestBody.raw
            .filter((part) => part.bytes)
            .map((part) => decoder.decode(part.bytes));
          body = chunks.join("");
        } catch {
          // Binary body — not representable as text
          body = null;
        }
      }

      // Form data (application/x-www-form-urlencoded or multipart text fields)
      if (!body && details.requestBody.formData) {
        const params = new URLSearchParams();
        for (const [key, values] of Object.entries(
          details.requestBody.formData,
        )) {
          for (const val of values) {
            params.append(key, val);
          }
        }
        body = params.toString();
      }

      if (body) {
        pendingBodies.set(details.requestId, body);
      }
    },
    { urls: ["<all_urls>"] },
    ["requestBody"],
  );

  // Capture request headers via onSendHeaders (fires after all modifications)
  browser.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.tabId < 0) return; // ignore non-tab requests

      let tabData = tabNetworkRequests.get(details.tabId);
      if (!tabData) {
        tabData = { requests: [], pending: new Map() };
        tabNetworkRequests.set(details.tabId, tabData);
      }

      const entry = {
        requestId: details.requestId,
        url: details.url,
        method: details.method,
        type: details.type,
        timestamp: details.timeStamp,
        requestHeaders: (details.requestHeaders || []).map((h) => ({
          name: h.name,
          value: h.value || "",
        })),
        responseHeaders: [],
        statusCode: 0,
        statusLine: "",
        requestBody: pendingBodies.get(details.requestId) || null,
      };

      // Clean up stashed body now that it's been merged into the entry
      pendingBodies.delete(details.requestId);

      tabData.pending.set(details.requestId, entry);
    },
    { urls: ["<all_urls>"] },
    webRequestOptions("requestHeaders"),
  );

  // Capture response headers and finalize the entry
  browser.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId < 0) return;

      const tabData = tabNetworkRequests.get(details.tabId);
      if (!tabData) return;

      const entry = tabData.pending.get(details.requestId);
      if (entry) {
        entry.responseHeaders = (details.responseHeaders || []).map((h) => ({
          name: h.name,
          value: h.value || "",
        }));
        entry.statusCode = details.statusCode;
        entry.statusLine = details.statusLine || "";
        entry.duration = details.timeStamp - entry.timestamp;

        tabData.pending.delete(details.requestId);

        // Add to ring buffer
        tabData.requests.push(entry);
        if (tabData.requests.length > MAX_REQUESTS_PER_TAB) {
          tabData.requests.shift();
        }
      }
    },
    { urls: ["<all_urls>"] },
    webRequestOptions("responseHeaders"),
  );

  // Handle errored requests (DNS fail, connection refused, etc.)
  browser.webRequest.onErrorOccurred.addListener(
    (details) => {
      if (details.tabId < 0) return;

      const tabData = tabNetworkRequests.get(details.tabId);
      if (!tabData) return;

      const entry = tabData.pending.get(details.requestId);
      if (entry) {
        entry.statusCode = 0;
        entry.statusLine = details.error || "Error";
        entry.duration = details.timeStamp - entry.timestamp;

        tabData.pending.delete(details.requestId);

        tabData.requests.push(entry);
        if (tabData.requests.length > MAX_REQUESTS_PER_TAB) {
          tabData.requests.shift();
        }
      }
    },
    { urls: ["<all_urls>"] },
  );
}

// Handle alarms
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM_NAME) {
    // Refresh badge for active tab
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then(async ([tab]) => {
        if (tab && tab.url) {
          try {
            const url = new URL(tab.url);
            const result = await browser.storage.local.get([
              "scrapeScore_" + url.hostname,
            ]);
            const score = result["scrapeScore_" + url.hostname];
            if (typeof score === "number") {
              updateBadgeWithScore(score);
            }
          } catch {
            // ignore
          }
        }
      });
  }

  if (alarm.name === SESSION_STALENESS_ALARM) {
    // Check all session profiles for staleness and notify side panels
    checkSessionProfileStaleness();
  }

  if (alarm.name === UPDATE_CHECK_ALARM) {
    checkForExtensionUpdate();
  }
});

/**
 * Periodically check session profiles for expired cookies.
 * Sends a notification to open side panels so they can update staleness badges.
 */
async function checkSessionProfileStaleness() {
  try {
    const profiles = await getAllSessionProfiles();
    let staleCount = 0;
    for (const profile of profiles) {
      const result = checkSessionStaleness(profile);
      if (result.stale) staleCount++;
    }
    if (staleCount > 0) {
      notifySidePanels({
        type: "SESSION_STALENESS_UPDATE",
        staleCount,
      });
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Extension Update Check (Firefox — Chrome uses native update_url)
// ---------------------------------------------------------------------------

/**
 * Compare two semver strings. Returns true if `current` is older than `latest`.
 */
function isVersionOutdated(current, latest) {
  const parse = (v) => v.split(".").map(Number);
  const [cMajor = 0, cMinor = 0, cPatch = 0] = parse(current);
  const [lMajor = 0, lMinor = 0, lPatch = 0] = parse(latest);
  if (cMajor !== lMajor) return cMajor < lMajor;
  if (cMinor !== lMinor) return cMinor < lMinor;
  return cPatch < lPatch;
}

/**
 * Check for a newer extension version via the AlterLab API.
 * If a newer version is found, stores the update info and shows a badge.
 * Works on both Chrome and Firefox, but primarily useful for Firefox
 * where there is no native auto-update for unsigned self-hosted extensions.
 */
async function checkForExtensionUpdate() {
  try {
    const response = await fetch(VERSION_API_URL);
    if (!response.ok) return;

    const data = await response.json();
    const latestVersion = data.version;
    if (!latestVersion) return;

    const currentVersion = browser.runtime.getManifest().version;

    if (isVersionOutdated(currentVersion, latestVersion)) {
      // Store update info for the popup/side panel to read
      await browser.storage.local.set({
        updateAvailable: {
          current: currentVersion,
          latest: latestVersion,
          download: data.download,
          release: data.release,
          checkedAt: new Date().toISOString(),
        },
      });

      // Show "!" badge to indicate update available
      browser.action.setBadgeText({ text: "!" });
      browser.action.setBadgeBackgroundColor({ color: "#f59e0b" });

      // Notify open side panels / popups
      notifySidePanels({
        type: "UPDATE_AVAILABLE",
        current: currentVersion,
        latest: latestVersion,
        download: data.download,
      });

      console.log(
        `[AlterLab] Update available: v${currentVersion} → v${latestVersion}`,
      );
    } else {
      // Clear any previous update notification
      const stored = await browser.storage.local.get("updateAvailable");
      if (stored.updateAvailable) {
        await browser.storage.local.remove("updateAvailable");
      }
    }
  } catch {
    // Network error — silently ignore, will retry on next alarm
  }
}

// ---------------------------------------------------------------------------
// URL Fetch (CORS bypass for robots.txt / sitemaps)
// ---------------------------------------------------------------------------

/**
 * Fetch a URL from the background service worker context.
 * This bypasses CORS restrictions since service workers are not subject
 * to the same-origin policy for fetch requests.
 */
async function handleFetchUrl(url) {
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "AlterLab-Connect/2.0",
        Accept: "text/plain, application/xml, text/xml, */*",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      return {
        error: `HTTP ${resp.status} ${resp.statusText}`,
        body: null,
        status: resp.status,
      };
    }
    const body = await resp.text();
    return { error: null, body, status: resp.status };
  } catch (err) {
    return { error: err.message || "Network error", body: null, status: 0 };
  }
}

// ---------------------------------------------------------------------------
// Cookie Retrieval (message handler)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sync Queue Replay — replays queued API requests when connectivity returns
// ---------------------------------------------------------------------------

let _replayInProgress = false;

async function replaySyncQueue() {
  if (_replayInProgress) return;
  _replayInProgress = true;

  try {
    const queue = await getSyncQueue();
    if (queue.length === 0) {
      _replayInProgress = false;
      return;
    }

    console.log(`[AlterLab] Replaying ${queue.length} queued request(s)...`);

    for (const entry of queue) {
      try {
        const resp = await fetch(entry.url, {
          method: entry.method,
          headers: entry.headers,
          body: entry.body ? JSON.stringify(entry.body) : undefined,
        });

        if (resp.ok) {
          // Success — remove from queue and notify side panel
          await removeFromSyncQueue(entry.id);
          const remaining = await getSyncQueueCount();
          notifySidePanels({
            type: "SYNC_RESULT",
            success: true,
            label: entry.label,
            queueType: entry.type,
          });
          notifySidePanels({
            type: "SYNC_QUEUE_UPDATED",
            count: remaining,
          });
          console.log(`[AlterLab] Synced: ${entry.label}`);
        } else {
          // Server error (4xx/5xx) — don't retry, remove from queue
          console.warn(
            `[AlterLab] Sync failed (HTTP ${resp.status}): ${entry.label}`,
          );
          await removeFromSyncQueue(entry.id);
          const remaining = await getSyncQueueCount();
          notifySidePanels({
            type: "SYNC_RESULT",
            success: false,
            label: entry.label,
            error: `HTTP ${resp.status}`,
            queueType: entry.type,
          });
          notifySidePanels({
            type: "SYNC_QUEUE_UPDATED",
            count: remaining,
          });
        }
      } catch (err) {
        // Network error during replay — stop processing, still offline
        console.warn(
          `[AlterLab] Still offline, stopping replay: ${err.message}`,
        );
        break;
      }
    }
  } finally {
    _replayInProgress = false;
  }
}

/**
 * Send a message to all open side panel / popup instances.
 */
function notifySidePanels(message) {
  browser.runtime.sendMessage(message).catch(() => {
    // No listeners — side panel may be closed
  });
}

// ---------------------------------------------------------------------------
// Cookie Retrieval (message handler)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Screenshot Capture — cross-browser (captureVisibleTab / captureTab)
// ---------------------------------------------------------------------------

/**
 * Capture a screenshot of the currently visible tab.
 * Must run in the background service worker context.
 *
 * Uses the cross-browser captureScreenshot() helper which routes to
 * browser.tabs.captureTab (Firefox) or browser.tabs.captureVisibleTab (Chrome).
 *
 * @returns {Promise<{error: string|null, dataUrl: string|null}>}
 */
async function handleCaptureScreenshot() {
  try {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) {
      return { error: "No active tab found", dataUrl: null };
    }

    const dataUrl = await captureScreenshot(tab.id, tab.windowId, {
      format: "png",
      quality: 100,
    });

    return { error: null, dataUrl };
  } catch (err) {
    return {
      error: err.message || "Failed to capture screenshot",
      dataUrl: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Scrape Page — One-shot scrape via AlterLab API (CORS bypass)
// ---------------------------------------------------------------------------

/**
 * Handle a SCRAPE_PAGE request from the side panel.
 * Uses the AlterLab API to scrape the given URL and return formatted content.
 *
 * If the API returns an async job response (job_id + status "queued" or
 * "processing"), this function polls GET /api/v1/jobs/{job_id} at 2-second
 * intervals until the job completes, fails, or the 90-second timeout elapses.
 *
 * @param {Object} message
 * @param {string} message.url - URL to scrape
 * @param {string} message.format - "markdown" | "html" | "json"
 * @param {string} message.apiKey - API key (empty for anonymous)
 * @param {string} message.apiUrl - Base API URL
 * @param {string} message.deviceId - Device UUID for anonymous tracking
 * @returns {Promise<{error: string|null, content: string|null, jobId: string|null, polling?: boolean}>}
 */
async function handleScrapePage(message) {
  const { url, format, apiKey, apiUrl, deviceId } = message;
  const baseUrl = apiUrl || ALTERLAB_DEFAULT_API_URL;

  const body = {
    url,
    formats: [
      format === "html" ? "html" : format === "json" ? "json" : "markdown",
    ],
  };

  const headers = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  } else if (deviceId) {
    headers["X-Device-Id"] = deviceId;
  }

  try {
    const resp = await fetch(`${baseUrl}/api/v1/scrape`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      return {
        error: errBody.detail || `HTTP ${resp.status}: ${resp.statusText}`,
        content: null,
        jobId: null,
      };
    }

    const result = await resp.json();
    const jobId = result.job_id || result.id || null;

    // Detect async job response — API returns 202 with job_id and a pending status
    const asyncStatuses = ["queued", "pending", "processing", "running"];
    if (jobId && result.status && asyncStatuses.includes(result.status)) {
      return await _pollJobUntilComplete(baseUrl, jobId, headers);
    }

    return { error: null, content: _extractContent(result), jobId };
  } catch (err) {
    return {
      error: err.message || "Network error — check your connection",
      content: null,
      jobId: null,
    };
  }
}

/**
 * Poll GET /api/v1/jobs/{jobId} until the job reaches a terminal state.
 * Polls every 2 seconds and gives up after 90 seconds.
 *
 * @param {string} baseUrl - API base URL
 * @param {string} jobId - Job ID to poll
 * @param {Object} headers - Request headers (includes auth)
 * @returns {Promise<{error: string|null, content: string|null, jobId: string}>}
 */
async function _pollJobUntilComplete(baseUrl, jobId, headers) {
  const POLL_INTERVAL_MS = 2000;
  const TIMEOUT_MS = 90000;
  const pollHeaders = { ...headers };
  // Polling endpoint does not need Content-Type
  delete pollHeaders["Content-Type"];

  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    let pollResp;
    try {
      pollResp = await fetch(`${baseUrl}/api/v1/jobs/${jobId}`, {
        method: "GET",
        headers: pollHeaders,
      });
    } catch (networkErr) {
      return {
        error: networkErr.message || "Network error while polling job status",
        content: null,
        jobId,
      };
    }

    if (!pollResp.ok) {
      // 404 means job not found or auth mismatch — surface the error
      const errBody = await pollResp.json().catch(() => ({}));
      return {
        error:
          errBody.detail ||
          `Job polling failed: HTTP ${pollResp.status}`,
        content: null,
        jobId,
      };
    }

    const job = await pollResp.json();
    const status = job.status || "";

    if (status === "succeeded" || status === "completed") {
      const content = _extractContent(job.result || job);
      return { error: null, content, jobId };
    }

    if (status === "failed" || status === "error") {
      const reason =
        (job.result && job.result.error) ||
        job.error ||
        "Scrape job failed on the server.";
      return { error: reason, content: null, jobId };
    }

    // Still queued/processing — continue polling
  }

  // Timeout
  return {
    error: `Scrape timed out after ${TIMEOUT_MS / 1000}s — job ${jobId} is still processing. Check your dashboard for results.`,
    content: null,
    jobId,
  };
}

/**
 * Extract displayable content from a scrape result or job result object.
 *
 * @param {Object} result - Scrape or job result payload
 * @returns {string} Extracted content string
 */
function _extractContent(result) {
  if (!result) return "";
  if (result.content) {
    return typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content, null, 2);
  }
  if (result.text) return result.text;
  if (result.markdown) return result.markdown;
  if (result.html) return result.html;
  if (result.data) return JSON.stringify(result.data, null, 2);
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// AlterLab Auth Detection
// ---------------------------------------------------------------------------

/**
 * Check if the user is logged in to AlterLab by reading session cookies.
 * NextAuth stores a session token cookie. If found, we fetch /api/v1/auth/me
 * using cookie-based auth (via the background service worker which can make
 * credentialed cross-origin requests).
 *
 * Returns:
 *   { authenticated: true, apiKey, email, credits } on success
 *   { authenticated: false } if no session or invalid
 *
 * @param {string} [apiUrl] - Base URL to check (default: https://alterlab.io)
 */
async function handleCheckAlterLabAuth(apiUrl) {
  const baseUrl = normalizeUrl(apiUrl || ALTERLAB_DEFAULT_API_URL);

  try {
    // Extract hostname for cookie lookup
    let hostname;
    try {
      hostname = new URL(baseUrl).hostname;
    } catch {
      return { authenticated: false, error: "Invalid API URL" };
    }

    // Look for NextAuth session cookies on the AlterLab domain
    // NextAuth uses __Secure-next-auth.session-token (production) or
    // next-auth.session-token (development/localhost)
    const sessionCookies = await browser.cookies.getAll({ domain: hostname });
    const hasSession = sessionCookies.some(
      (c) =>
        c.name === "__Secure-next-auth.session-token" ||
        c.name === "next-auth.session-token" ||
        c.name === "authjs.session-token" ||
        c.name === "__Secure-authjs.session-token",
    );

    if (!hasSession) {
      return { authenticated: false };
    }

    // Session cookie exists — fetch API keys via the Next.js cookie-authenticated
    // proxy at /api/keys. This endpoint reads the NextAuth session cookie,
    // generates a short-lived JWT, and proxies to FastAPI /api/v1/api-keys.
    // We do NOT call /api/v1/auth/me because it requires X-API-Key auth, not cookies.
    const resp = await fetch(`${baseUrl}/api/keys`, {
      method: "GET",
      credentials: "include",
    });

    if (!resp.ok) {
      // Cookie exists but session may be expired or proxy unavailable
      return {
        authenticated: false,
        error: `Session expired (HTTP ${resp.status})`,
      };
    }

    const data = await resp.json();
    const keys = data.items || [];

    if (keys.length === 0) {
      // User is authenticated but has no API keys
      return {
        authenticated: true,
        hasApiKey: false,
        keys: [],
      };
    }

    // Return the key list for the popup to display.
    // Each key has: id, name, key_prefix, created_at, last_used_at, requests
    // The full key value is NOT included — the popup must call DECRYPT_API_KEY
    // for the selected key.
    return {
      authenticated: true,
      hasApiKey: true,
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.key_prefix,
        createdAt: k.created_at,
        lastUsedAt: k.last_used_at,
        requests: k.requests || 0,
      })),
    };
  } catch (err) {
    return { authenticated: false, error: err.message };
  }
}

/**
 * Decrypt and return the full API key value for a given key ID.
 * Uses the Next.js cookie-authenticated proxy at /api/keys/{id}.
 *
 * @param {string} [apiUrl] - Base URL (default: https://alterlab.io)
 * @param {string} keyId - UUID of the API key to decrypt
 * @returns {Promise<{key: string}|{error: string}>}
 */
async function handleDecryptApiKey(apiUrl, keyId) {
  const baseUrl = normalizeUrl(apiUrl || ALTERLAB_DEFAULT_API_URL);

  try {
    const resp = await fetch(`${baseUrl}/api/keys/${keyId}`, {
      method: "GET",
      credentials: "include",
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      return {
        error: errBody.error || errBody.detail || `HTTP ${resp.status}`,
      };
    }

    const data = await resp.json();
    return { key: data.key };
  } catch (err) {
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Session Cookie Change Listener — auto-detect login/logout
// ---------------------------------------------------------------------------

// NextAuth session cookie names (production uses __Secure- prefix, dev does not)
const SESSION_COOKIE_NAMES = new Set([
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
  "authjs.session-token",
  "__Secure-authjs.session-token",
]);

// Debounce timer to avoid rapid-fire triggers during login flow
// (NextAuth may set/update the cookie multiple times in quick succession)
let _sessionCookieDebounce = null;

/**
 * Listen for cookie changes on the AlterLab domain.
 * When a NextAuth session cookie is SET (not removed), trigger auth check
 * and auto-configure the extension with the user's API key.
 */
browser.cookies.onChanged.addListener((changeInfo) => {
  const { cookie, removed, cause } = changeInfo;

  // Only care about NextAuth session cookies
  if (!SESSION_COOKIE_NAMES.has(cookie.name)) return;

  // Check if this cookie belongs to the AlterLab domain
  // Cookie domain may be ".alterlab.io" or "alterlab.io" or "localhost"
  const cookieDomain = cookie.domain.replace(/^\./, "");
  const alterlabHost = (() => {
    try {
      return new URL(ALTERLAB_DEFAULT_API_URL).hostname;
    } catch {
      return "alterlab.io";
    }
  })();

  // Match the domain (exact or subdomain)
  if (
    cookieDomain !== alterlabHost &&
    !alterlabHost.endsWith("." + cookieDomain)
  ) {
    return;
  }

  if (removed) {
    // Cookie removed (logout or expiry) — clear stored config and notify UI
    if (cause === "explicit" || cause === "expired" || cause === "overwrite") {
      handleSessionCookieRemoved();
    }
    return;
  }

  // Cookie was set or updated — user just logged in
  // Debounce: wait 1s after the last cookie change before triggering
  if (_sessionCookieDebounce) {
    clearTimeout(_sessionCookieDebounce);
  }
  _sessionCookieDebounce = setTimeout(() => {
    _sessionCookieDebounce = null;
    handleSessionCookieSet();
  }, 1000);
});

/**
 * Handle session cookie being set — user logged in on AlterLab.
 * Auto-run auth check, decrypt first API key, save config, notify UI.
 */
async function handleSessionCookieSet() {
  try {
    // Check if already configured — don't overwrite existing config
    const config = await loadConfig();
    if (config.apiKey) {
      console.log(
        "[AlterLab] Session cookie detected but already configured — skipping.",
      );
      return;
    }

    console.log("[AlterLab] Session cookie detected — running auto-auth...");

    const apiUrl = config.apiUrl || ALTERLAB_DEFAULT_API_URL;
    const authResult = await handleCheckAlterLabAuth(apiUrl);

    if (!authResult || !authResult.authenticated) {
      console.log(
        "[AlterLab] Auth check returned not authenticated — cookie may be stale.",
      );
      return;
    }

    if (
      !authResult.hasApiKey ||
      !authResult.keys ||
      authResult.keys.length === 0
    ) {
      // User is authenticated but has no API keys — notify UI to show appropriate state
      notifySidePanels({
        type: "AUTH_STATUS_CHANGED",
        authenticated: true,
        hasApiKey: false,
      });
      console.log("[AlterLab] User authenticated but has no API keys.");
      return;
    }

    // Auto-select the first API key and decrypt it
    const selectedKey = authResult.keys[0];
    const decryptResult = await handleDecryptApiKey(apiUrl, selectedKey.id);

    if (!decryptResult || !decryptResult.key) {
      console.warn(
        "[AlterLab] Failed to decrypt API key:",
        decryptResult?.error,
      );
      return;
    }

    // Save config
    await saveConfig(decryptResult.key, apiUrl);

    // Notify all open extension views (sidepanel, popup)
    notifySidePanels({ type: "CONFIG_UPDATED" });

    console.log("[AlterLab] Auto-configured after login detection.");
  } catch (err) {
    console.error("[AlterLab] Session cookie handler error:", err);
  }
}

/**
 * Handle session cookie being removed — user logged out.
 * Only notify UI if we were previously configured via auto-auth.
 */
async function handleSessionCookieRemoved() {
  console.log("[AlterLab] Session cookie removed — user may have logged out.");
  // Don't auto-clear config on logout — the user may have manually entered
  // their API key. Just notify the UI so it can re-check if needed.
  notifySidePanels({ type: "AUTH_STATUS_CHANGED", authenticated: false });
}

// ---------------------------------------------------------------------------
// Cookie Retrieval (message handler)
// ---------------------------------------------------------------------------

async function handleGetCookies(domain, url) {
  try {
    const baseDomain = getBaseDomain(domain);
    const domainCookies = await browser.cookies.getAll({ domain: baseDomain });
    const urlCookies = url ? await browser.cookies.getAll({ url }) : [];

    const seen = new Set();
    const merged = [];

    for (const cookie of [...domainCookies, ...urlCookies]) {
      const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
          expirationDate: cookie.expirationDate || null,
        });
      }
    }

    merged.sort((a, b) => a.name.localeCompare(b.name));
    return { cookies: merged, error: null };
  } catch (err) {
    return { cookies: [], error: err.message };
  }
}
