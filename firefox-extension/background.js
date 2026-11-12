/**
 * AlterLab Connect - Background Script (Firefox)
 *
 * Orchestrates:
 * - Sidebar lifecycle (Firefox sidebar_action API)
 * - Badge management (scrape complexity score)
 * - Context menu creation ("Scrape this element", "Copy selector")
 * - Message routing between popup, sidebar, and content scripts
 *
 * Firefox differences from Chrome:
 * - shared.js is loaded via manifest background.scripts (no importScripts)
 * - browser.sidebarAction replaces chrome.sidePanel
 * - No injectImmediately option for scripting.executeScript
 * - "extraHeaders" option not supported for webRequest listeners
 */

const BADGE_ALARM_NAME = "alterlab-badge-refresh";
const BADGE_REFRESH_MINUTES = 30;
const SESSION_STALENESS_ALARM = "alterlab-session-staleness";
const SESSION_STALENESS_MINUTES = 60;

// Synchronous guard against a duplicate welcome tab when onInstalled fires
// twice in quick succession (Firefox temporary add-on reloads).
let welcomeTabOpenedInMemory = false;

// Per-tab storage for security header signals detected via webRequest
const tabHeaderSignals = new Map();

// Per-tab storage for raw response headers (used by content script anti-bot detection)
const tabResponseHeaders = new Map();

// Per-tab ring buffer for network request/response headers (Headers tab)
const MAX_REQUESTS_PER_TAB = 200;
const tabNetworkRequests = new Map(); // tabId -> { requests: [], pending: Map }

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "update") {
    // Erase the identifier older versions stored (no longer generated or sent)
    chrome.storage.local.remove("alterlabDeviceId");
  }

  if (details.reason === "install") {
    console.log("[AlterLab] Extension installed.");
    chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });

    // Set first-run flags — overlay will show once on first sidebar open
    chrome.storage.local.set({
      firstRunComplete: false,
      hasSeenOverlay: false,
    });

    // Open the welcome tab once. The in-memory flag is set synchronously so a
    // second onInstalled right after the first (temporary add-on reloads)
    // bails out before the async storage check completes.
    if (!welcomeTabOpenedInMemory) {
      welcomeTabOpenedInMemory = true;
      chrome.storage.local.get("welcomeTabOpened").then(({ welcomeTabOpened }) => {
        if (welcomeTabOpened) return;
        chrome.storage.local.set({ welcomeTabOpened: true });
        chrome.tabs.create({
          url: "https://alterlab.io/welcome?source=firefox-extension",
          active: true,
        });
      });
    }
  } else if (details.reason === "update") {
    console.log(
      `[AlterLab] Extension updated to v${chrome.runtime.getManifest().version}`,
    );
    // Earlier versions persisted per-domain scores; drop that history
    purgeLegacyDomainHistory().catch(() => {});
  }

  // Set up periodic badge refresh
  chrome.alarms.create(BADGE_ALARM_NAME, {
    periodInMinutes: BADGE_REFRESH_MINUTES,
  });

  // Set up periodic session staleness check
  chrome.alarms.create(SESSION_STALENESS_ALARM, {
    periodInMinutes: SESSION_STALENESS_MINUTES,
  });

  // Create context menus
  createContextMenus();

  // Firefox sidebar is enabled via manifest — no runtime setup needed
});

// ---------------------------------------------------------------------------
// Context Menus
// ---------------------------------------------------------------------------

function createContextMenus() {
  // Remove existing menus first to avoid duplicates
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "alterlab-scrape-element",
      title: "Scrape this element",
      contexts: ["all"],
    });

    chrome.contextMenus.create({
      id: "alterlab-copy-selector",
      title: "Copy selector",
      contexts: ["all"],
    });

    chrome.contextMenus.create({
      id: "alterlab-separator",
      type: "separator",
      contexts: ["all"],
    });

    chrome.contextMenus.create({
      id: "alterlab-open-sidepanel",
      title: "Open AlterLab Connect",
      contexts: ["all"],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "alterlab-open-sidepanel") {
    try {
      // Firefox uses browser.sidebarAction to toggle the sidebar
      await browser.sidebarAction.toggle();
    } catch {
      // fallback — sidebar may already be open or API unavailable
    }
    return;
  }

  if (info.menuItemId === "alterlab-scrape-element") {
    // Send message to content script to get the clicked element's selector
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "GET_ELEMENT_SELECTOR",
      });
      if (response && response.selector) {
        // Store selector for sidebar Job tab to use
        await chrome.storage.local.set({
          lastElementSelector: response.selector,
          lastElementUrl: tab.url,
        });
        // Open sidebar on Job tab
        await chrome.storage.local.set({ sidepanelOpenTab: "job" });
        await browser.sidebarAction.open();
      }
    } catch {
      // Content script not available on this page
    }
    return;
  }

  if (info.menuItemId === "alterlab-copy-selector") {
    try {
      // Inject a small script to copy the element under cursor
      await chrome.scripting.executeScript({
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
// Message handling
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_COOKIES") {
    handleGetCookies(message.domain, message.url).then(sendResponse);
    return true; // async response
  }

  if (message.type === "CONNECT_REQUEST") {
    // Agent connect request relayed by the dashboard bridge. The user's consent
    // prompt and the single-site permission gate everything inside requestConnect.
    AlterLabConnect.requestConnect(message.request, connectDeps())
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message || "Connect failed", code: err.code }));
    return true; // async response
  }

  if (message.type === "BRIDGE_CONFIRM_RESULT") {
    // Only the extension's own confirmation page may resolve a request
    const confirmUrl = chrome.runtime.getURL("confirm.html");
    const pending = pendingBridgeConfirms.get(message.id);
    if (pending && sender.url && sender.url.startsWith(confirmUrl)) {
      pending(message.approved === true);
    }
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "BADGE_LOADING") {
    // Show "..." while page analysis is in progress
    chrome.action.setBadgeText({ text: "..." });
    chrome.action.setBadgeBackgroundColor({ color: "#44403c" }); // muted grey
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "BADGE_ERROR") {
    // Show "!" when analysis fails
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" }); // error red
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "SCRAPE_SCORE") {
    // Store score and update badge
    const score = message.score;
    const domain = message.domain;
    if (typeof score === "number" && domain) {
      if (typeof message.tabId === "number") {
        chrome.storage.session.set({ ["tabScore_" + message.tabId]: { score, domain } });
      }
      updateBadgeWithScore(score);
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
      .catch((err) => sendResponse({ error: err.message, body: null, status: 0 }));
    return true; // async response
  }

  if (message.type === "START_NETWORK_MONITOR") {
    sendResponse(startNetworkMonitor(message.tabId));
    return false;
  }

  if (message.type === "STOP_NETWORK_MONITOR") {
    stopNetworkMonitor(message.tabId);
    sendResponse({ status: "ok" });
    return false;
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

  if (message.type === "SESSION_SAVED" || message.type === "CONFIG_UPDATED") {
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "SESSION_PROFILE_COUNT") {
    // Update badge with local session profile count for the active domain
    const count = message.count || 0;
    if (count > 0) {
      chrome.action.setBadgeText({ text: String(count) });
      chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
    }
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "CONNECTIVITY_RESTORED") {
    replaySyncQueue();
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "SELECTOR_PICKED" || message.type === "SELECTOR_ESCAPED") {
    // Forward from content script to side panel
    notifySidePanels(message);
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "PING") {
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "GET_API_RUN") {
    AlterLabGetApi.runGetApi(fetch, message).then(sendResponse);
    return true;
  }

  if (message.type === "GET_API_PUBLISH") {
    AlterLabGetApi.publishPage(fetch, message).then(sendResponse);
    return true;
  }

  if (message.type === "GET_API_SCHEDULE") {
    AlterLabGetApi.schedulePage(fetch, message).then(sendResponse);
    return true;
  }

  if (message.type === "SCRAPE_PAGE") {
    handleScrapePage(message).then(sendResponse);
    return true; // async response
  }

  if (message.type === "CAPTURE_SCREENSHOT") {
    handleCaptureScreenshot().then(sendResponse);
    return true; // async response
  }
});

// ---------------------------------------------------------------------------
// Tab change — update badge for new tab
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// On-demand network monitor
// ---------------------------------------------------------------------------

// The webRequest listeners exist only while the user has the Network tab open
// for a tab (optional "webRequest" + host permission granted at that moment).
const NETWORK_MONITOR_TABS_KEY = "networkMonitorTabs";
const monitoredTabs = new Set();
const monitorListeners = [];

function addMonitorListener(event, ...args) {
  event.addListener(...args);
  monitorListeners.push([event, args[0]]);
}

function unregisterNetworkMonitor() {
  for (const [event, fn] of monitorListeners) event.removeListener(fn);
  monitorListeners.length = 0;
}

function persistMonitoredTabs() {
  chrome.storage.session.set({ [NETWORK_MONITOR_TABS_KEY]: [...monitoredTabs] });
}

function startNetworkMonitor(tabId) {
  if (!chrome.webRequest) return { ok: false, error: "permission" };
  monitoredTabs.add(tabId);
  registerNetworkMonitor();
  persistMonitoredTabs();
  return { ok: true };
}

function stopNetworkMonitor(tabId) {
  monitoredTabs.delete(tabId);
  tabNetworkRequests.delete(tabId);
  tabHeaderSignals.delete(tabId);
  tabResponseHeaders.delete(tabId);
  if (monitoredTabs.size === 0) unregisterNetworkMonitor();
  persistMonitoredTabs();
}

async function restoreNetworkMonitor() {
  if (!chrome.webRequest) return;
  const stored = await chrome.storage.session.get(NETWORK_MONITOR_TABS_KEY);
  for (const id of stored[NETWORK_MONITOR_TABS_KEY] || []) monitoredTabs.add(id);
  if (monitoredTabs.size > 0) registerNetworkMonitor();
}

// ---------------------------------------------------------------------------
// Tab change — badge shows the score of an analysis the user already ran
// ---------------------------------------------------------------------------

// Scores are kept per tab in session storage (cleared when the browser
// closes); no per-domain browsing history is persisted.
async function refreshBadgeForTab(tabId, url) {
  try {
    const key = "tabScore_" + tabId;
    const stored = await chrome.storage.session.get(key);
    const entry = stored[key];
    if (entry && typeof entry.score === "number" && entry.domain === new URL(url).hostname) {
      updateBadgeWithScore(entry.score);
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    chrome.action.setBadgeText({ text: "" });
  }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && tab.url) {
      refreshBadgeForTab(tab.id, tab.url);
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    chrome.action.setBadgeText({ text: "" });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // New navigation: drop the stale score and restart the monitor buffer
  if (changeInfo.status === "loading") {
    if (monitoredTabs.has(tabId)) {
      tabNetworkRequests.set(tabId, { requests: [], pending: new Map() });
    }
    chrome.storage.session.remove("tabScore_" + tabId);
    chrome.action.setBadgeText({ text: "" });
  }
});

// Clean up header signals and network requests when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  stopNetworkMonitor(tabId);
  chrome.storage.session.remove("tabScore_" + tabId);
});

// ---------------------------------------------------------------------------
// Badge Management
// ---------------------------------------------------------------------------

// Track previous badge score for pulse animation
let lastBadgeScore = null;

function updateBadgeWithScore(score) {
  const color = scrapeScoreColor(score);
  chrome.action.setBadgeText({ text: String(score) });
  chrome.action.setBadgeBackgroundColor({ color });

  // Pulse effect: briefly flash badge when score changes between pages
  if (lastBadgeScore !== null && lastBadgeScore !== score) {
    chrome.action.setBadgeBackgroundColor({ color: "#ffffff" });
    setTimeout(() => {
      chrome.action.setBadgeBackgroundColor({ color });
    }, 150);
    setTimeout(() => {
      chrome.action.setBadgeBackgroundColor({ color: "#ffffff" });
    }, 300);
    setTimeout(() => {
      chrome.action.setBadgeBackgroundColor({ color });
    }, 450);
  }
  lastBadgeScore = score;
}

// ---------------------------------------------------------------------------
// WebRequest Header Analysis
// ---------------------------------------------------------------------------

// Listen for response headers to detect server-side security signals.
// This runs in the background service worker and has access to HTTP headers
// that are invisible to content scripts.
function registerNetworkMonitor() {
  if (!chrome.webRequest || monitorListeners.length > 0) return;

  addMonitorListener(
    chrome.webRequest.onHeadersReceived,
    (details) => {
      if (!monitoredTabs.has(details.tabId)) return;
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
        if (
          name === "strict-transport-security" &&
          value.includes("max-age")
        ) {
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
          chrome.scripting.executeScript({
            target: { tabId: details.tabId },
            func: (headerData) => {
              window.__alterlabHeaderCache = headerData;
            },
            args: [headerMap],
          }).catch(() => {
            // Can't inject into this page (chrome://, extensions, etc.)
          });
        } catch {
          // scripting API not available
        }
      }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"],
  );

  // ---------------------------------------------------------------------------
  // Network Request Capture (Headers tab)
  // ---------------------------------------------------------------------------
  // Capture request headers via onSendHeaders (fires after all modifications)
  addMonitorListener(
    chrome.webRequest.onSendHeaders,
    (details) => {
      if (!monitoredTabs.has(details.tabId)) return;
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
      };

      tabData.pending.set(details.requestId, entry);
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders"],
  );

  // Capture response headers and finalize the entry
  addMonitorListener(
    chrome.webRequest.onCompleted,
    (details) => {
      if (!monitoredTabs.has(details.tabId)) return;
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
    ["responseHeaders"],
  );

  // Handle errored requests (DNS fail, connection refused, etc.)
  addMonitorListener(
    chrome.webRequest.onErrorOccurred,
    (details) => {
      if (!monitoredTabs.has(details.tabId)) return;
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
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM_NAME) {
    // Refresh badge for active tab
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (tab && tab.id && tab.url) refreshBadgeForTab(tab.id, tab.url);
      });
  }

  if (alarm.name === SESSION_STALENESS_ALARM) {
    // Check all session profiles for staleness and notify side panels
    checkSessionProfileStaleness();
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
        console.warn(`[AlterLab] Still offline, stopping replay: ${err.message}`);
        break;
      }
    }
  } finally {
    _replayInProgress = false;
  }
}

/**
 * Send a message to all open sidebar / popup instances.
 */
function notifySidePanels(message) {
  chrome.runtime
    .sendMessage({ ...message, target: "sidepanel" })
    .catch(() => {
      // No listeners — side panel may be closed
    });
}

// ---------------------------------------------------------------------------
// Cookie Retrieval (message handler)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Screenshot Capture — uses chrome.tabs.captureVisibleTab
// ---------------------------------------------------------------------------

/**
 * Capture a screenshot of the currently visible tab.
 * Must run in the background service worker context where
 * chrome.tabs.captureVisibleTab is available.
 * @returns {Promise<{error: string|null, dataUrl: string|null}>}
 */
async function handleCaptureScreenshot() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) {
      return { error: "No active tab found", dataUrl: null };
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
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
 * @param {Object} message
 * @param {string} message.url - URL to scrape
 * @param {string} message.format - "markdown" | "html" | "json"
 * @param {string} message.apiKey - API key (empty for anonymous)
 * @param {string} message.apiUrl - Base API URL
 * @returns {Promise<{error: string|null, content: string|null, jobId: string|null}>}
 */
async function handleScrapePage(message) {
  const { url, format, apiKey, apiUrl } = message;
  const baseUrl = apiUrl || ALTERLAB_DEFAULT_API_URL;

  const body = {
    url,
    formats: [format === "html" ? "html" : format === "json" ? "json" : "markdown"],
  };

  const headers = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers["X-API-Key"] = apiKey;
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

    // Async job response: the API returns a job id with a pending status
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
 */
async function _pollJobUntilComplete(baseUrl, jobId, headers) {
  const POLL_INTERVAL_MS = 2000;
  const TIMEOUT_MS = 90000;
  const pollHeaders = { ...headers };
  delete pollHeaders["Content-Type"];

  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    let pollResp;
    try {
      pollResp = await fetch(`${baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}`, {
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
      const errBody = await pollResp.json().catch(() => ({}));
      return {
        error: errBody.detail || `Job polling failed: HTTP ${pollResp.status}`,
        content: null,
        jobId,
      };
    }

    const job = await pollResp.json();
    const status = job.status || "";

    if (status === "succeeded" || status === "completed") {
      return { error: null, content: _extractContent(job.result || job), jobId };
    }

    if (status === "failed" || status === "error") {
      const reason =
        (job.result && job.result.error) ||
        job.error ||
        "Scrape job failed on the server.";
      return { error: reason, content: null, jobId };
    }
    // Still queued/processing: keep polling
  }

  return {
    error: `Scrape timed out after ${TIMEOUT_MS / 1000}s \u2014 job ${jobId} is still processing. Check your dashboard for results.`,
    content: null,
    jobId,
  };
}

/**
 * Extract displayable content from a scrape result or job result object.
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
// Cookie Retrieval (message handler)
// ---------------------------------------------------------------------------

async function handleGetCookies(domain, url) {
  try {
    const baseDomain = getBaseDomain(domain);
    const domainCookies = await chrome.cookies.getAll({ domain: baseDomain });
    const urlCookies = url ? await chrome.cookies.getAll({ url }) : [];

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

// Pending dashboard-capture confirmations: id -> resolve(approved)
const pendingBridgeConfirms = new Map();
const BRIDGE_CONFIRM_TIMEOUT_MS = 60000;

/**
 * Open an extension-owned window asking the user to confirm cookie capture
 * for baseDomain. Resolves false on deny, close, timeout or a concurrent request.
 */
function confirmBridgeCapture(target) {
  const info = typeof target === "string" ? { baseDomain: target } : target;
  const baseDomain = info.baseDomain;
  if (pendingBridgeConfirms.size > 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    let windowId = null;
    let done = false;
    const onRemoved = (removedId) => {
      if (removedId === windowId) finish(false);
    };
    const timer = setTimeout(() => finish(false), BRIDGE_CONFIRM_TIMEOUT_MS);
    function finish(approved) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pendingBridgeConfirms.delete(id);
      chrome.windows.onRemoved.removeListener(onRemoved);
      if (windowId !== null) chrome.windows.remove(windowId).catch(() => {});
      resolve(approved);
    }
    pendingBridgeConfirms.set(id, finish);
    chrome.windows.onRemoved.addListener(onRemoved);
    const url =
      chrome.runtime.getURL("confirm.html") +
      `?id=${encodeURIComponent(id)}&domain=${encodeURIComponent(baseDomain)}` +
      (info.scopes
        ? `&agent=${encodeURIComponent(info.agent || "")}` +
          `&scopes=${encodeURIComponent(info.scopes.join(","))}` +
          `&origin=${encodeURIComponent(AlterLabConnect.originPattern(baseDomain))}`
        : "");
    chrome.windows
      .create({ url, type: "popup", width: 420, height: 420 })
      .then((win) => {
        windowId = win.id;
        if (done) chrome.windows.remove(win.id).catch(() => {});
      })
      .catch(() => finish(false));
  });
}

// ---------------------------------------------------------------------------
// AlterLab Connect v2: on-request capture, sealed refresh, revoke (#38934)
// ---------------------------------------------------------------------------

const CONNECT_REFRESH_ALARM = "alterlab-connect-refresh";
const CONNECT_REFRESH_MINUTES = 15;
const connectRefreshInFlight = new Set();

/** localStorage of open tabs on the consented site only (needs that site's grant). */
async function captureLocalStorage(baseDomain) {
  const out = {};
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: AlterLabConnect.originPattern(baseDomain) });
  } catch {
    return out;
  }
  for (const tab of tabs) {
    try {
      const origin = new URL(tab.url).origin;
      if (out[origin]) continue;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => Object.fromEntries(Object.entries(window.localStorage)),
      });
      if (res && res.result) out[origin] = res.result;
    } catch {
      // Tab not scriptable: skip it
    }
  }
  return out;
}

function connectDeps() {
  return {
    getBaseDomain,
    confirm: (info) => confirmBridgeCapture(info),
    hasOrigin: (pattern) => chrome.permissions.contains({ origins: [pattern] }),
    removeOrigin: (pattern) => chrome.permissions.remove({ origins: [pattern] }),
    getCookies: (baseDomain) => handleGetCookies(baseDomain, null),
    getLocalStorage: captureLocalStorage,
    getConfig: loadConfig,
    fetch: (...args) => fetch(...args),
    crypto: globalThis.crypto,
    storage: chrome.storage.local,
    now: () => Date.now(),
    // Expiry prompt: badge now, details in the activity panel (no extra permission).
    notifyExpired: async () => {
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
    },
  };
}

chrome.alarms.create(CONNECT_REFRESH_ALARM, { periodInMinutes: CONNECT_REFRESH_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CONNECT_REFRESH_ALARM) {
    AlterLabConnect.refreshPending(connectDeps()).catch(() => {});
    runRetentionSweep();
  }
});

// Retention (#38949): revoke connected sites older than the user's retention period.
function runRetentionSweep() {
  const deps = connectDeps();
  AlterLabPrivacy.sweepRetention({
    storage: deps.storage,
    now: deps.now,
    revokeSite: (domain) => AlterLabConnect.revokeSite(domain, deps),
  }).catch(() => {});
}
runRetentionSweep();

// Refresh approved sites when their cookies change (throttled inside connect.js).
chrome.cookies.onChanged.addListener((changeInfo) => {
  const domain = String(changeInfo.cookie.domain || "").replace(/^\./, "");
  const baseDomain = getBaseDomain(domain);
  if (!baseDomain || connectRefreshInFlight.has(baseDomain)) return;
  connectRefreshInFlight.add(baseDomain);
  AlterLabConnect.refreshSite(baseDomain, connectDeps())
    .catch(() => {})
    .finally(() => connectRefreshInFlight.delete(baseDomain));
});


// BYOS session freshness: cookie monitoring for domains with a saved session
AlterLabByos.startMonitor({
  chrome,
  loadConfig,
  getBaseDomain,
  notify: notifySidePanels,
  consent: AlterLabConsent,
});

restoreNetworkMonitor().catch(() => {});

// Hands approvals (#38937): poll pending agent requests and surface them as notifications.
const handsPendingById = new Map();
const handsApprovalDeps = {
  fetch: (...args) => fetch(...args),
  baseUrl: ALTERLAB_DEFAULT_API_URL,
  notify: async (id, options, req) => {
    handsPendingById.set(req.id, req);
    // Firefox notifications have no buttons: a click opens the dashboard to decide.
    const { buttons, ...plain } = options;
    chrome.notifications.create(id, { ...plain, iconUrl: "icons/icon128.png" });
  },
};
chrome.alarms.create(AlterLabHandsApprovals.POLL_ALARM, {
  periodInMinutes: AlterLabHandsApprovals.POLL_MINUTES,
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AlterLabHandsApprovals.POLL_ALARM) {
    AlterLabHandsApprovals.poll(handsApprovalDeps).catch(() => {});
  }
});
chrome.notifications.onButtonClicked.addListener((id, index) => {
  AlterLabHandsApprovals.onButton(handsPendingById, id, index, handsApprovalDeps)
    .then(() => chrome.notifications.clear(id))
    .catch(() => {});
});
// Hands credential requests (#39876): notify once per pending request; click opens the prompt.
const handsCredentialDeps = {
  fetch: (...args) => fetch(...args),
  baseUrl: ALTERLAB_DEFAULT_API_URL,
  // Session cookie only: approvals and credentials are the user's, never an API key's.
  headers: async () => ({}),
  notify: async (id, options) => {
    const { buttons, ...plain } = options;
    chrome.notifications.create(id, { ...plain, iconUrl: "icons/icon128.png" });
  },
};
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AlterLabHandsApprovals.POLL_ALARM) {
    AlterLabHandsCredentials.poll(handsCredentialDeps).catch(() => {});
  }
});
chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith(AlterLabHandsCredentials.NOTIFY_PREFIX)) {
    chrome.tabs.create({
      url: chrome.runtime.getURL(
        `credential-request.html?id=${encodeURIComponent(id.slice(AlterLabHandsCredentials.NOTIFY_PREFIX.length))}`,
      ),
    });
    return;
  }
  if (id.startsWith(AlterLabHandsApprovals.NOTIFY_PREFIX)) {
    chrome.tabs.create({ url: `${ALTERLAB_DEFAULT_API_URL}/dashboard/hands` });
  }
});

// Hands local execution (#38946): run local-mode tasks in a dedicated tab of this profile.
const handsLocalDeps = {
  fetch: (...args) => fetch(...args),
  baseUrl: ALTERLAB_DEFAULT_API_URL,
  running: new Map(),
  newAbort: () => new AbortController(),
  setBadge: (text) => chrome.action.setBadgeText({ text }),
  openTab: async (url) => (await chrome.tabs.create({ url, active: false })).id,
  closeTab: (tabId) => chrome.tabs.remove(tabId),
  getTab: (tabId) => chrome.tabs.get(tabId).catch(() => null),
  executeScript: (tabId, func, args) => chrome.scripting.executeScript({ target: { tabId }, func, args }),
  navigate: (tabId, url, timeoutMs) =>
    new Promise((resolve) => {
      const done = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      };
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") done();
      };
      const timer = setTimeout(done, timeoutMs);
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.update(tabId, { url });
    }),
  settle: () => new Promise((resolve) => setTimeout(resolve, 800)),
};
chrome.alarms.create(AlterLabHandsLocal.DISCOVER_ALARM, {
  periodInMinutes: AlterLabHandsLocal.DISCOVER_MINUTES,
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AlterLabHandsLocal.DISCOVER_ALARM) {
    AlterLabHandsLocal.discover(handsLocalDeps).catch(() => {});
  }
});
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === AlterLabHandsLocal.STOP_MESSAGE) {
    AlterLabHandsLocal.stopTask(handsLocalDeps, message.taskId).catch(() => {});
  }
});

// Recipe recorder (#38945): one tab, one origin, explicit start/stop. Steps carry no typed values.
let recorderSession = null;
let recorderTabId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RECORDER_START") {
    (async () => {
      if (recorderSession && recorderSession.active) {
        return sendResponse({ success: false, error: "A recording is already running." });
      }
      try {
        recorderSession = AlterLabRecorder.createSession({ tabId: message.tabId, startUrl: message.url });
        recorderTabId = message.tabId;
        await chrome.scripting.executeScript({ target: { tabId: message.tabId }, files: ["recorder-content.js"] });
        sendResponse({ success: true });
      } catch (err) {
        recorderSession = null;
        sendResponse({ success: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }
  if (message.type === "RECORDER_EVENT") {
    if (recorderSession && sender.tab && sender.tab.id === recorderTabId) {
      recorderSession.add({ ...message.event, tabId: sender.tab.id });
    }
    return false;
  }
  if (message.type === "RECORDER_STOP") {
    const steps = recorderSession ? recorderSession.stop() : [];
    const tabId = recorderTabId;
    recorderSession = null;
    recorderTabId = null;
    if (tabId != null) {
      chrome.scripting
        .executeScript({ target: { tabId }, func: () => window.__alterlabRecorder && window.__alterlabRecorder.stop() })
        .catch(() => {});
    }
    sendResponse({ success: true, steps });
    return false;
  }
  return false;
});
