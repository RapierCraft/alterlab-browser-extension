/**
 * AlterLab Connect — ESLint Flat Config
 *
 * Targets ES2022 browser extension globals (chrome, browser, ServiceWorkerGlobalScope).
 * Content scripts, popup, and background scripts run in different environments,
 * but we use browser globals for all of them since the polyfill provides `browser`
 * everywhere.
 */

import globals from "globals";

/** @type {import("eslint").Linter.Config[]} */
export default [
  // -------------------------------------------------------------------------
  // Global ignores
  // -------------------------------------------------------------------------
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "browser-polyfill.min.js",
      "store-assets/**",
    ],
  },

  // -------------------------------------------------------------------------
  // Extension source files (background, content, popup, sidepanel, theme)
  // -------------------------------------------------------------------------
  {
    files: ["*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script", // Extension scripts are not ES modules
      globals: {
        ...globals.browser,
        // WebExtension polyfill — available in all extension contexts
        browser: "readonly",
        chrome: "readonly",
        // Service Worker globals
        ServiceWorkerGlobalScope: "readonly",
        self: "readonly",
        importScripts: "readonly",
        // shared.js globals — declared in shared.js, used by popup.js, sidepanel.js, background.js
        // These are loaded via <script src="shared.js"> (script tags) or importScripts(),
        // so they are available as globals in all extension contexts.
        ALTERLAB_DEFAULT_API_URL: "readonly",
        AUTH_COOKIE_PATTERNS: "readonly",
        FREE_SCRAPE_LIMIT: "readonly",
        SYNC_QUEUE_KEY: "readonly",
        SESSION_PROFILES_KEY: "readonly",
        DEVICE_ID_KEY: "readonly",
        SCRAPE_USAGE_KEY: "readonly",
        checkFreeScrapeAllowance: "readonly",
        checkSessionStaleness: "readonly",
        cookieByteSize: "readonly",
        cookieKey: "readonly",
        escapeHtml: "readonly",
        estimateCredits: "readonly",
        exportKeyValueFormat: "readonly",
        exportNetscapeFormat: "readonly",
        formatBytes: "readonly",
        formatCookieDate: "readonly",
        getAllSessionProfiles: "readonly",
        getBaseDomain: "readonly",
        getDeviceId: "readonly",
        getScrapeUsageCount: "readonly",
        getSyncQueue: "readonly",
        getSyncQueueCount: "readonly",
        hideStatus: "readonly",
        incrementScrapeUsage: "readonly",
        isAuthCookie: "readonly",
        isCookieExpired: "readonly",
        isNetworkError: "readonly",
        isOnline: "readonly",
        loadConfig: "readonly",
        normalizeUrl: "readonly",
        addToSyncQueue: "readonly",
        clearSyncQueue: "readonly",
        removeFromSyncQueue: "readonly",
        sameSiteLabel: "readonly",
        saveConfig: "readonly",
        scoreToTier: "readonly",
        scrapeScoreColor: "readonly",
        scrapeScoreLabel: "readonly",
        scrapeScoreTier: "readonly",
        showStatus: "readonly",
        showToast: "readonly",
        dismissToast: "readonly",
        diffSessionProfiles: "readonly",
        getSessionProfileById: "readonly",
        getSessionProfilesForDomain: "readonly",
        saveSessionProfile: "readonly",
        deleteSessionProfile: "readonly",
      },
    },
    rules: {
      // Errors
      "no-undef": "error",
      "no-unused-vars": ["error", { vars: "all", args: "after-used", ignoreRestSiblings: true, caughtErrors: "none" }],
      "no-console": "off", // Extensions use console for debugging
      "no-duplicate-case": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-unreachable": "error",

      // Warnings — style / quality
      "eqeqeq": ["warn", "always", { null: "ignore" }],
      "no-var": "warn",
      "prefer-const": ["warn", { destructuring: "any" }],
      "no-throw-literal": "warn",

      // Off — intentional patterns in extension code
      "no-prototype-builtins": "off",
    },
  },

  // -------------------------------------------------------------------------
  // shared.js — utility library loaded via <script> tag or importScripts().
  // All exported symbols appear "unused" from ESLint's perspective because
  // consumers load the file separately. Override no-unused-vars here.
  // This config must come AFTER the generic *.js config to take precedence.
  // -------------------------------------------------------------------------
  {
    files: ["shared.js"],
    rules: {
      "no-unused-vars": "off",
    },
  },

  // -------------------------------------------------------------------------
  // Build tooling (Node.js ESM scripts)
  // -------------------------------------------------------------------------
  {
    files: ["build.mjs", "playwright.config.mjs", "vitest.config.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { vars: "all", args: "after-used" }],
      "no-console": "off",
    },
  },

  // -------------------------------------------------------------------------
  // Tests (Playwright + Vitest)
  // -------------------------------------------------------------------------
  {
    files: ["tests/**/*.mjs", "tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
        browser: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { vars: "all", args: "after-used" }],
    },
  },
];
