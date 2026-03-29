/**
 * AlterLab Connect — Browser API Abstraction
 *
 * Provides a unified `browser` namespace via webextension-polyfill.
 * On Chrome, the polyfill wraps chrome.* callbacks into Promises.
 * On Firefox, `browser` is already the native namespace.
 *
 * Usage:
 *   All scripts import the polyfill first, then use `browser.*` everywhere.
 *   For Chrome-only APIs (e.g., chrome.sidePanel), use feature-detection:
 *     if (browser.sidePanel) { await browser.sidePanel.open(...); }
 *
 * Note: The polyfill does NOT cover every Chrome-specific API. APIs not in
 * the polyfill's metadata (like chrome.sidePanel, chrome.action in MV3)
 * fall through to the native chrome.* namespace automatically since the
 * polyfill proxies unknown properties to chrome.*.
 */

// The polyfill script (browser-polyfill.min.js) must be loaded before this file.
// It exposes `globalThis.browser` which wraps chrome.* with Promise-based APIs.
//
// For service workers (background.js), use importScripts("browser-polyfill.min.js")
// For content scripts and pages, add <script src="browser-polyfill.min.js"> in HTML
//
// After loading the polyfill, `browser` is available globally — no further
// action needed in this file. This file serves as documentation and as a
// central place for any future cross-browser shims.

/**
 * Check if a browser API namespace exists (feature detection).
 * Use this for Chrome-only APIs that may not exist on Firefox.
 *
 * @param {string} namespace - dot-separated path, e.g. "sidePanel"
 * @returns {boolean}
 */
function hasBrowserAPI(namespace) {
  const parts = namespace.split(".");
  let obj = typeof browser !== "undefined" ? browser : chrome;
  for (const part of parts) {
    if (!obj || typeof obj[part] === "undefined") return false;
    obj = obj[part];
  }
  return true;
}
