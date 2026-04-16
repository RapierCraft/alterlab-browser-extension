/**
 * AlterLab Connect - Shared Utilities
 *
 * Common code used by popup, side panel, background, and content scripts.
 * Extracted to avoid duplication and ensure consistency.
 */

const ALTERLAB_DEFAULT_API_URL = "https://alterlab.io";

/**
 * Escape a string for safe insertion into HTML.
 * Uses the DOM's built-in text-node serialisation so every character that
 * the browser would treat as markup (including single-quotes in attribute
 * values) is encoded correctly.
 */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Cookie name patterns that commonly indicate authentication state.
 */
const AUTH_COOKIE_PATTERNS = [
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
  /^session-id/i,
  /^ubid-/i,
  /^at-/i,
  /^x-/i,
  /^li_at$/i,
  /^JSESSIONID$/i,
  /^connect\.sid$/i,
  /^laravel_session$/i,
  /^PHPSESSID$/i,
  /^ASP\.NET_SessionId$/i,
  /^wordpress_logged_in/i,
  /^__Secure-/i,
  /^__Host-/i,
];

/**
 * Load config from browser.storage.local.
 */
async function loadConfig() {
  const result = await browser.storage.local.get(["apiKey", "apiUrl"]);
  return {
    apiKey: result.apiKey || "",
    apiUrl: result.apiUrl || ALTERLAB_DEFAULT_API_URL,
  };
}

/**
 * Save config to browser.storage.local.
 */
async function saveConfig(apiKey, apiUrl) {
  await browser.storage.local.set({ apiKey, apiUrl });
}

/**
 * Check if a cookie name matches known auth cookie patterns.
 */
function isAuthCookie(name) {
  return AUTH_COOKIE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Unique key for a cookie (name + domain + path).
 */
function cookieKey(cookie) {
  return `${cookie.name}|${cookie.domain}|${cookie.path}`;
}

/**
 * Normalize a URL (add https://, strip trailing slash).
 */
function normalizeUrl(url) {
  url = url.replace(/\/+$/, "");
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

/**
 * Show a status message in a status element.
 */
function showStatus(el, type, html) {
  el.className = `status visible ${type}`;
  el.innerHTML = html;
}

/**
 * Hide a status message element.
 */
function hideStatus(el) {
  el.className = "status";
  el.innerHTML = "";
}

/**
 * Scrape score color based on value (0-100).
 * Green (easy) -> Yellow (moderate) -> Orange (hard) -> Red (very hard).
 */
function scrapeScoreColor(score) {
  if (score <= 30) return "#22c55e"; // green  — Tier 1: static HTML
  if (score <= 60) return "#f59e0b"; // yellow — Tier 2: JS rendering / basic protection
  if (score <= 80) return "#f97316"; // orange — Tier 3: anti-bot active
  return "#ef4444"; // red    — Tier 4: heavy anti-bot, CAPTCHA
}

/**
 * Map a scrape score to the recommended AlterLab tier (1-4).
 * Canonical implementation — used everywhere score→tier mapping is needed.
 */
function scoreToTier(score) {
  if (score == null || score <= 30) return 1;
  if (score <= 60) return 2;
  if (score <= 80) return 3;
  return 4;
}

// Backward-compat alias — remove once all callers use scoreToTier directly.
const scrapeScoreTier = scoreToTier;

/**
 * Human-readable difficulty label for a scrape score.
 */
function scrapeScoreLabel(score) {
  if (score <= 20) return "Very Easy";
  if (score <= 40) return "Easy";
  if (score <= 60) return "Moderate";
  if (score <= 80) return "Hard";
  return "Very Hard";
}

/**
 * Estimate credit costs at different page scales based on the recommended tier.
 * Returns an object with costs for 1K, 100K, and 1M pages.
 * Pricing mirrors AlterLab tier microcents: T1=$0.0002, T2=$0.0003, T3=$0.002, T4=$0.004, T5=$0.02.
 */
function estimateCredits(score) {
  const tier = scrapeScoreTier(score);
  const costPerPage = {
    1: 0.0002,
    2: 0.0003,
    3: 0.002,
    4: 0.004,
  }[tier] || 0.004;

  return {
    tier,
    costPerPage,
    scales: {
      "1K": { pages: 1000, cost: (costPerPage * 1000).toFixed(2) },
      "100K": { pages: 100000, cost: (costPerPage * 100000).toFixed(2) },
      "1M": { pages: 1000000, cost: (costPerPage * 1000000).toFixed(2) },
    },
  };
}

/**
 * Calculate the approximate byte size of a cookie.
 * Name + value + domain + path + overhead for flags.
 */
function cookieByteSize(cookie) {
  let size = 0;
  size += (cookie.name || "").length;
  size += (cookie.value || "").length;
  size += (cookie.domain || "").length;
  size += (cookie.path || "").length;
  // Approximate overhead for flags, expiry, etc.
  size += 20;
  return size;
}

/**
 * Format byte size for display.
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Export cookies as Netscape/Mozilla cookie file format.
 * This is the format used by curl, wget, and browser cookie files.
 */
function exportNetscapeFormat(cookies) {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# https://curl.se/docs/http-cookies.html",
    "# Generated by AlterLab Connect",
    "",
  ];
  for (const cookie of cookies) {
    const domain = cookie.domain.startsWith(".")
      ? cookie.domain
      : "." + cookie.domain;
    const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = cookie.secure ? "TRUE" : "FALSE";
    const expiry = cookie.expirationDate
      ? String(Math.floor(cookie.expirationDate))
      : "0";
    lines.push(
      `${domain}\t${includeSubdomains}\t${cookie.path}\t${secure}\t${expiry}\t${cookie.name}\t${cookie.value}`,
    );
  }
  return lines.join("\n");
}

/**
 * Export cookies as key=value pairs (one per line).
 * Suitable for use in Cookie headers.
 */
function exportKeyValueFormat(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Get SameSite label from cookie's sameSite property.
 */
function sameSiteLabel(sameSite) {
  if (!sameSite || sameSite === "unspecified" || sameSite === "no_restriction")
    return "None";
  return sameSite.charAt(0).toUpperCase() + sameSite.slice(1).toLowerCase();
}

/**
 * Check if a cookie is expired.
 */
function isCookieExpired(cookie) {
  if (cookie.session || !cookie.expirationDate) return false;
  return cookie.expirationDate * 1000 < Date.now();
}

/**
 * Format a Unix timestamp to a readable date string.
 */
function formatCookieDate(timestamp) {
  if (!timestamp) return "Session";
  const d = new Date(timestamp * 1000);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Connectivity & Sync Queue
// ---------------------------------------------------------------------------

const SYNC_QUEUE_KEY = "alterlabSyncQueue";

/**
 * Check if the browser is currently online.
 */
function isOnline() {
  return navigator.onLine;
}

/**
 * Check if a fetch error is a network error (offline/DNS/timeout)
 * vs. a server error (4xx/5xx response).
 */
function isNetworkError(err) {
  if (err instanceof TypeError && err.message === "Failed to fetch") return true;
  if (err.name === "AbortError") return false; // deliberate abort
  if (err.message && /network|offline|dns|econnrefused/i.test(err.message))
    return true;
  return false;
}

/**
 * Add a failed API request to the sync queue in browser.storage.local.
 * Each entry stores enough info to replay the request later.
 *
 * @param {Object} entry
 * @param {string} entry.type - "session" | "scrape"
 * @param {string} entry.url - Full API URL
 * @param {string} entry.method - HTTP method
 * @param {Object} entry.headers - Request headers
 * @param {Object} entry.body - Request body (will be JSON-stringified)
 * @param {string} entry.label - Human-readable label for the UI
 * @param {number} [entry.timestamp] - Auto-set if missing
 */
async function addToSyncQueue(entry) {
  entry.timestamp = entry.timestamp || Date.now();
  entry.id = entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await browser.storage.local.get([SYNC_QUEUE_KEY]);
  const queue = result[SYNC_QUEUE_KEY] || [];
  queue.push(entry);
  await browser.storage.local.set({ [SYNC_QUEUE_KEY]: queue });
  return queue.length;
}

/**
 * Get all items in the sync queue.
 * @returns {Promise<Array>}
 */
async function getSyncQueue() {
  const result = await browser.storage.local.get([SYNC_QUEUE_KEY]);
  return result[SYNC_QUEUE_KEY] || [];
}

/**
 * Get the count of items in the sync queue.
 * @returns {Promise<number>}
 */
async function getSyncQueueCount() {
  const queue = await getSyncQueue();
  return queue.length;
}

/**
 * Clear the entire sync queue.
 * @returns {Promise<void>}
 */
async function clearSyncQueue() {
  await browser.storage.local.remove([SYNC_QUEUE_KEY]);
}

/**
 * Remove a specific item from the sync queue by id.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function removeFromSyncQueue(id) {
  const result = await browser.storage.local.get([SYNC_QUEUE_KEY]);
  const queue = (result[SYNC_QUEUE_KEY] || []).filter((e) => e.id !== id);
  await browser.storage.local.set({ [SYNC_QUEUE_KEY]: queue });
}

// ---------------------------------------------------------------------------
// Named Session Profiles (browser.storage.local)
// ---------------------------------------------------------------------------

const SESSION_PROFILES_KEY = "alterlabSessionProfiles";

/**
 * Session profile schema:
 * {
 *   id: string,           // unique ID
 *   name: string,         // user-given name, e.g. "Amazon Prime - Work"
 *   domain: string,       // base domain, e.g. "amazon.com"
 *   cookies: Array<{      // full cookie objects for injection
 *     name, value, domain, path, secure, httpOnly, sameSite, expirationDate
 *   }>,
 *   synced: boolean,      // true if pushed to AlterLab API
 *   syncedAt: number|null,// timestamp of last sync
 *   createdAt: number,    // timestamp
 *   updatedAt: number,    // timestamp
 * }
 */

/**
 * Get all saved session profiles.
 * @returns {Promise<Array>}
 */
async function getAllSessionProfiles() {
  const result = await browser.storage.local.get([SESSION_PROFILES_KEY]);
  return result[SESSION_PROFILES_KEY] || [];
}

/**
 * Get session profiles for a specific domain.
 * @param {string} domain - base domain
 * @returns {Promise<Array>}
 */
async function getSessionProfilesForDomain(domain) {
  const all = await getAllSessionProfiles();
  const base = getBaseDomain(domain);
  return all.filter((s) => getBaseDomain(s.domain) === base);
}

/**
 * Save a new session profile (or update existing by id).
 * @param {Object} profile
 * @returns {Promise<Object>} the saved profile
 */
async function saveSessionProfile(profile) {
  const all = await getAllSessionProfiles();
  const now = Date.now();

  if (profile.id) {
    // Update existing
    const idx = all.findIndex((s) => s.id === profile.id);
    if (idx >= 0) {
      all[idx] = { ...all[idx], ...profile, updatedAt: now };
      await _persistSessionProfiles(all);
      return all[idx];
    }
  }

  // Create new
  const newProfile = {
    id: `sp_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name: profile.name || "Untitled Session",
    domain: profile.domain || "",
    cookies: profile.cookies || [],
    synced: profile.synced || false,
    syncedAt: profile.syncedAt || null,
    createdAt: now,
    updatedAt: now,
  };
  all.push(newProfile);
  await _persistSessionProfiles(all);
  return newProfile;
}

/**
 * Delete a session profile by id.
 * @param {string} id
 * @returns {Promise<boolean>} true if found and deleted
 */
async function deleteSessionProfile(id) {
  const all = await getAllSessionProfiles();
  const filtered = all.filter((s) => s.id !== id);
  if (filtered.length === all.length) return false;
  await _persistSessionProfiles(filtered);
  return true;
}

/**
 * Get a single session profile by id.
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
async function getSessionProfileById(id) {
  const all = await getAllSessionProfiles();
  return all.find((s) => s.id === id) || null;
}

/**
 * Check how many cookies in a session profile are stale (expired).
 * @param {Object} profile - session profile
 * @returns {{ total: number, expired: number, stale: boolean }}
 */
function checkSessionStaleness(profile) {
  const now = Date.now() / 1000; // cookie expiry is in seconds
  let expired = 0;
  let total = profile.cookies.length;
  for (const cookie of profile.cookies) {
    if (cookie.expirationDate && cookie.expirationDate < now) {
      expired++;
    }
  }
  return {
    total,
    expired,
    stale: expired > 0,
    allExpired: expired === total && total > 0,
  };
}

/**
 * Compute a diff between two session profiles' cookies.
 * Returns added, removed, and changed cookies.
 * @param {Object} profileA
 * @param {Object} profileB
 * @returns {{ added: Array, removed: Array, changed: Array, unchanged: Array }}
 */
function diffSessionProfiles(profileA, profileB) {
  const mapA = new Map();
  const mapB = new Map();

  for (const c of profileA.cookies) {
    mapA.set(c.name, c);
  }
  for (const c of profileB.cookies) {
    mapB.set(c.name, c);
  }

  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const [name, cookie] of mapA) {
    if (!mapB.has(name)) {
      removed.push(cookie);
    } else {
      const other = mapB.get(name);
      if (cookie.value !== other.value) {
        changed.push({ name, a: cookie, b: other });
      } else {
        unchanged.push(cookie);
      }
    }
  }

  for (const [name, cookie] of mapB) {
    if (!mapA.has(name)) {
      added.push(cookie);
    }
  }

  return { added, removed, changed, unchanged };
}

/** Internal: persist the session profiles array. */
async function _persistSessionProfiles(profiles) {
  await browser.storage.local.set({ [SESSION_PROFILES_KEY]: profiles });
}

// ---------------------------------------------------------------------------
// Toast Notification System
// ---------------------------------------------------------------------------

/**
 * SVG icons for toast types — compact inline SVGs.
 */
const TOAST_ICONS = {
  success:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warning:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

/**
 * Show a toast notification.
 *
 * @param {string} type - "success" | "error" | "warning" | "info"
 * @param {string} title - Short title text
 * @param {string} [message] - Optional detail message
 * @param {Object} [options] - Additional options
 * @param {number} [options.duration=5000] - Auto-dismiss time in ms (0 = no auto-dismiss)
 * @param {string} [options.actionLabel] - Text for optional action button
 * @param {Function} [options.onAction] - Callback when action button is clicked
 * @returns {HTMLElement} The toast element (for programmatic removal)
 */
function showToast(type, title, message, options = {}) {
  const container = document.getElementById("toastContainer");
  if (!container) return null;

  const duration =
    options.duration !== undefined ? options.duration : 5000;

  // Build toast element
  const toast = document.createElement("div");
  toast.className = `al-toast al-toast-${type}`;
  toast.style.pointerEvents = "auto";

  // Icon
  const iconEl = document.createElement("span");
  iconEl.className = "al-toast-icon";
  iconEl.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info;
  toast.appendChild(iconEl);

  // Body
  const bodyEl = document.createElement("div");
  bodyEl.className = "al-toast-body";

  const titleEl = document.createElement("div");
  titleEl.className = "al-toast-title";
  titleEl.textContent = title;
  bodyEl.appendChild(titleEl);

  if (message) {
    const msgEl = document.createElement("div");
    msgEl.className = "al-toast-message";
    msgEl.textContent = message;
    bodyEl.appendChild(msgEl);
  }

  // Action button (optional)
  if (options.actionLabel && options.onAction) {
    const actionBtn = document.createElement("button");
    actionBtn.className = "al-toast-action";
    actionBtn.textContent = options.actionLabel;
    actionBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      options.onAction();
      dismissToast(toast);
    });
    bodyEl.appendChild(actionBtn);
  }

  toast.appendChild(bodyEl);

  // Close button
  const closeBtn = document.createElement("button");
  closeBtn.className = "al-toast-close";
  closeBtn.innerHTML = "&times;";
  closeBtn.addEventListener("click", () => dismissToast(toast));
  toast.appendChild(closeBtn);

  container.appendChild(toast);

  // Auto-dismiss
  if (duration > 0) {
    toast._dismissTimer = setTimeout(() => dismissToast(toast), duration);
  }

  // Limit visible toasts to 3
  const toasts = container.querySelectorAll(".al-toast:not(.al-toast-exit)");
  if (toasts.length > 3) {
    dismissToast(toasts[0]);
  }

  return toast;
}

/**
 * Dismiss a toast with exit animation.
 */
function dismissToast(toast) {
  if (!toast || toast.classList.contains("al-toast-exit")) return;
  if (toast._dismissTimer) {
    clearTimeout(toast._dismissTimer);
  }
  toast.classList.add("al-toast-exit");
  toast.addEventListener(
    "animationend",
    () => {
      toast.remove();
    },
    { once: true },
  );
  // Fallback removal if animation doesn't fire
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 300);
}

// ---------------------------------------------------------------------------
// Device Identity & Free Tier Usage Tracking
// ---------------------------------------------------------------------------

const DEVICE_ID_KEY = "alterlabDeviceId";
const SCRAPE_USAGE_KEY = "alterlabScrapeUsage";
const FREE_SCRAPE_LIMIT = 3;

/**
 * Get or generate a stable device UUID.
 * Persisted in browser.storage.local so it survives extension updates.
 * @returns {Promise<string>}
 */
async function getDeviceId() {
  const result = await browser.storage.local.get([DEVICE_ID_KEY]);
  if (result[DEVICE_ID_KEY]) {
    return result[DEVICE_ID_KEY];
  }
  // Generate a v4-style UUID
  const uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
    /[xy]/g,
    (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    },
  );
  await browser.storage.local.set({ [DEVICE_ID_KEY]: uuid });
  return uuid;
}

/**
 * Get the current free scrape usage count.
 * @returns {Promise<number>}
 */
async function getScrapeUsageCount() {
  const result = await browser.storage.local.get([SCRAPE_USAGE_KEY]);
  return result[SCRAPE_USAGE_KEY] || 0;
}

/**
 * Increment the free scrape usage counter.
 * @returns {Promise<number>} The new count after incrementing.
 */
async function incrementScrapeUsage() {
  const current = await getScrapeUsageCount();
  const newCount = current + 1;
  await browser.storage.local.set({ [SCRAPE_USAGE_KEY]: newCount });
  return newCount;
}

/**
 * Check if the user has free scrapes remaining (without an API key).
 * @returns {Promise<{allowed: boolean, used: number, limit: number}>}
 */
async function checkFreeScrapeAllowance() {
  const used = await getScrapeUsageCount();
  return {
    allowed: used < FREE_SCRAPE_LIMIT,
    used,
    limit: FREE_SCRAPE_LIMIT,
  };
}
