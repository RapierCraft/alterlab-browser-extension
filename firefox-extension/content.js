/**
 * AlterLab Connect - Content Script
 *
 * Injected on demand (user action only) to analyze scrape complexity and detect page
 * characteristics. Sends results to background/side panel via message passing.
 *
 * Runs in the page context — has DOM access but no chrome.* API access
 * (except chrome.runtime for messaging).
 */

(() => {
  "use strict";

  // Injected on demand (scripting.executeScript) — never twice per page
  if (window.__alterlabContentLoaded) return;
  window.__alterlabContentLoaded = true;

  /**
   * Analyze the current page and compute a scrape complexity score (0-100).
   * Higher score = harder to scrape.
   */
  function analyzePage() {
    const analysis = {
      url: window.location.href,
      domain: window.location.hostname,
      title: document.title,
      timestamp: Date.now(),
      score: 0,
      signals: [],
      antiBot: [],
      pagination: null,
      apiEndpoints: [],
      meta: {},
    };

    // --- Score factors ---
    let score = 0;

    // 1. Check for anti-bot indicators
    const antiBotChecks = detectAntiBot();
    analysis.antiBot = antiBotChecks.detected;
    analysis.antiBotStack = antiBotChecks.detectedStructured;
    score += antiBotChecks.score;
    if (antiBotChecks.detected.length > 0) {
      analysis.signals.push(
        `Anti-bot: ${antiBotChecks.detected.join(", ")}`,
      );
    }

    // 2. Check if page is CSR (client-side rendered)
    const csrResult = detectCSR();
    if (csrResult.isCSR) {
      score += 25;
      analysis.signals.push("Client-side rendered (JS required)");
    }

    // 3. Check for iframes
    const iframeCount = document.querySelectorAll("iframe").length;
    if (iframeCount > 3) {
      score += 10;
      analysis.signals.push(`${iframeCount} iframes detected`);
    }

    // 4. Check for shadow DOM
    const shadowHosts = document.querySelectorAll("*");
    let shadowCount = 0;
    for (let i = 0; i < Math.min(shadowHosts.length, 500); i++) {
      if (shadowHosts[i].shadowRoot) shadowCount++;
    }
    if (shadowCount > 0) {
      score += 15;
      analysis.signals.push(`${shadowCount} shadow DOM elements`);
    }

    // 5. Check for dynamic loading patterns
    const hasInfiniteScroll = detectInfiniteScroll();
    if (hasInfiniteScroll) {
      score += 10;
      analysis.signals.push("Infinite scroll detected");
    }

    // 6. Check for login walls
    const hasLoginWall = detectLoginWall();
    if (hasLoginWall) {
      score += 20;
      analysis.signals.push("Login wall detected");
    }

    // 6b. Check for cookie gates / consent walls
    const cookieGate = detectCookieGate();
    if (cookieGate.detected) {
      score += cookieGate.isOverlay ? 10 : 5;
      analysis.signals.push(
        cookieGate.isOverlay
          ? "Cookie consent wall (blocks content)"
          : "Cookie consent required",
      );
    }

    // 7. Detect pagination
    analysis.pagination = detectPagination();
    if (analysis.pagination) {
      analysis.signals.push(`Pagination: ${analysis.pagination.type}`);
    }

    // 8. Detect API endpoints (from scripts, fetch, XHR)
    analysis.apiEndpoints = detectAPIEndpoints();

    // 9. Collect meta tags
    analysis.meta = collectMeta();

    // 10. Check robots meta
    const robotsMeta = document.querySelector('meta[name="robots"]');
    if (robotsMeta) {
      const content = robotsMeta.getAttribute("content") || "";
      if (content.includes("noindex") || content.includes("nofollow")) {
        score += 5;
        analysis.signals.push(`Robots: ${content}`);
      }
    }

    // 11. Detect tech stack (frameworks, CDNs, analytics, hosting)
    analysis.techStack = detectTechStack(antiBotChecks.detected, csrResult);

    // Cap score at 100
    analysis.score = Math.min(100, Math.max(0, score));

    return analysis;
  }

  /**
   * Anti-bot detection database. Each entry defines what to look for and
   * metadata used by the side panel for categorized rendering.
   *
   * Categories:
   *   bot-management  — Bot management / anti-bot platforms
   *   captcha         — CAPTCHA systems
   *   fingerprinting  — Browser fingerprinting services
   *   waf             — Web Application Firewalls / CDN protection
   *   js-challenge    — JavaScript challenge mechanisms
   */
  const ANTIBOT_SIGNATURES = [
    // ---- Bot Management ----
    {
      name: "Cloudflare Bot Management",
      category: "bot-management",
      tier: 3,
      technique: "Stealth browser with TLS fingerprint rotation",
      scoreWeight: 15,
      detect: (ctx) =>
        ctx.hasScript("cdn-cgi/challenge-platform") ||
        ctx.hasCookie("__cf_bm") ||
        ctx.hasCookie("cf_clearance") ||
        ctx.hasElement("#cf-wrapper") ||
        ctx.hasGlobal("_cf_chl_opt"),
    },
    {
      name: "DataDome",
      category: "bot-management",
      tier: 4,
      technique: "Residential proxies with session replay",
      scoreWeight: 25,
      detect: (ctx) =>
        ctx.hasScript("datadome") ||
        ctx.hasCookie("datadome") ||
        ctx.hasGlobal("ddjskey"),
    },
    {
      name: "PerimeterX / HUMAN",
      category: "bot-management",
      tier: 4,
      technique: "Residential proxies with sensor data spoofing",
      scoreWeight: 25,
      detect: (ctx) =>
        ctx.hasScript("perimeterx") ||
        ctx.hasScript("px-cdn") ||
        ctx.hasCookie("_pxhd") ||
        ctx.hasCookie("_pxvid") ||
        ctx.hasGlobal("_pxAppId"),
    },
    {
      name: "Akamai Bot Manager",
      category: "bot-management",
      tier: 3,
      technique: "Stealth browser with sensor data generation",
      scoreWeight: 20,
      detect: (ctx) =>
        ctx.hasScript("akamaihd") ||
        ctx.hasCookie("_abck") ||
        ctx.hasCookie("bm_sz") ||
        ctx.hasCookie("ak_bmsc"),
    },
    {
      name: "Kasada",
      category: "bot-management",
      tier: 4,
      technique: "Residential proxies with full browser emulation",
      scoreWeight: 25,
      detect: (ctx) =>
        ctx.hasScript("ips.js") ||
        ctx.hasGlobal("KPSDK"),
    },
    {
      name: "Shape Security (F5)",
      category: "bot-management",
      tier: 4,
      technique: "Full browser emulation with residential proxies",
      scoreWeight: 20,
      detect: (ctx) =>
        ctx.hasScript("shape") ||
        ctx.hasCookie("_imp_apg"),
    },
    {
      name: "Distil Networks",
      category: "bot-management",
      tier: 3,
      technique: "Stealth browser with proxy rotation",
      scoreWeight: 20,
      detect: (ctx) =>
        ctx.hasScript("distil") ||
        ctx.hasCookie("D_SID") ||
        ctx.hasCookie("D_IID") ||
        ctx.hasCookie("D_ZID"),
    },

    // ---- CAPTCHAs ----
    {
      name: "reCAPTCHA",
      category: "captcha",
      tier: 3,
      technique: "CAPTCHA solving service integration",
      scoreWeight: 20,
      detect: (ctx) =>
        ctx.hasElement(".g-recaptcha") ||
        ctx.hasScript("recaptcha") ||
        ctx.hasElement('iframe[src*="recaptcha"]') ||
        ctx.hasGlobal("grecaptcha"),
    },
    {
      name: "hCaptcha",
      category: "captcha",
      tier: 3,
      technique: "CAPTCHA solving service integration",
      scoreWeight: 20,
      detect: (ctx) =>
        ctx.hasElement(".h-captcha") ||
        ctx.hasScript("hcaptcha") ||
        ctx.hasGlobal("hcaptcha"),
    },
    {
      name: "Cloudflare Turnstile",
      category: "captcha",
      tier: 3,
      technique: "Managed challenge bypass via stealth browser",
      scoreWeight: 20,
      detect: (ctx) =>
        ctx.hasElement(".cf-turnstile") ||
        ctx.hasScript("challenges.cloudflare.com/turnstile") ||
        ctx.hasElement('iframe[src*="challenges.cloudflare.com"]'),
    },
    {
      name: "FunCaptcha (Arkose Labs)",
      category: "captcha",
      tier: 4,
      technique: "Specialized CAPTCHA solving with image recognition",
      scoreWeight: 25,
      detect: (ctx) =>
        ctx.hasScript("arkoselabs") ||
        ctx.hasScript("funcaptcha") ||
        ctx.hasElement("#FunCaptcha") ||
        ctx.hasGlobal("ArkoseEnforcement"),
    },

    // ---- Fingerprinting ----
    {
      name: "FingerprintJS",
      category: "fingerprinting",
      tier: 3,
      technique: "Browser fingerprint randomization",
      scoreWeight: 15,
      detect: (ctx) =>
        ctx.hasScript("fingerprintjs") ||
        ctx.hasScript("fpjs") ||
        ctx.hasScript("cdn.fpjs.io") ||
        ctx.hasGlobal("FingerprintJS"),
    },
    {
      name: "ThreatMetrix",
      category: "fingerprinting",
      tier: 3,
      technique: "Device fingerprint masking",
      scoreWeight: 15,
      detect: (ctx) =>
        ctx.hasScript("threatmetrix") ||
        ctx.hasScript("online-metrix"),
    },

    // ---- WAFs ----
    {
      name: "Cloudflare WAF",
      category: "waf",
      tier: 2,
      technique: "Standard proxy rotation with valid headers",
      scoreWeight: 10,
      detect: (ctx) =>
        ctx.hasHeader("cf-ray") ||
        ctx.hasHeader("cf-cache-status") ||
        ctx.hasScript("cdn-cgi"),
    },
    {
      name: "Imperva WAF",
      category: "waf",
      tier: 3,
      technique: "Stealth browser with residential proxies",
      scoreWeight: 20,
      detect: (ctx) =>
        ctx.hasScript("incapsula") ||
        ctx.hasScript("imperva") ||
        ctx.hasCookie("incap_ses") ||
        ctx.hasCookie("visid_incap") ||
        ctx.hasHeader("x-iinfo"),
    },
    {
      name: "Fastly WAF",
      category: "waf",
      tier: 2,
      technique: "Standard proxy rotation",
      scoreWeight: 10,
      detect: (ctx) =>
        ctx.hasHeader("x-served-by") ||
        ctx.hasHeader("x-cache") ||
        ctx.hasHeader("via"),
      // via header is generic; x-served-by is Fastly-specific
      validate: (ctx) =>
        ctx.headerContains("x-served-by", "cache-") ||
        ctx.headerContains("via", "varnish"),
    },
    {
      name: "AWS WAF",
      category: "waf",
      tier: 2,
      technique: "Standard proxy rotation with header management",
      scoreWeight: 10,
      detect: (ctx) =>
        ctx.hasHeader("x-amzn-requestid") ||
        ctx.hasHeader("x-amz-cf-id") ||
        ctx.hasCookie("aws-waf-token") ||
        ctx.hasCookie("AWSALB"),
    },

    // ---- JS Challenges ----
    {
      name: "Cloudflare IUAM",
      category: "js-challenge",
      tier: 3,
      technique: "Stealth browser with challenge solving",
      scoreWeight: 20,
      detect: (ctx) =>
        ctx.hasElement("#cf-wrapper") ||
        ctx.hasElement("#challenge-running") ||
        ctx.hasScript("challenges.cloudflare.com") ||
        ctx.hasGlobal("_cf_chl_opt"),
    },
    {
      name: "PerimeterX Sensor",
      category: "js-challenge",
      tier: 4,
      technique: "Full sensor data emulation",
      scoreWeight: 25,
      detect: (ctx) =>
        ctx.hasScript("px-cdn") ||
        ctx.hasScript("px-captcha") ||
        ctx.hasGlobal("_pxAppId") ||
        ctx.hasGlobal("window._pxUuid"),
    },
  ];

  /**
   * Detect anti-bot protection systems on the page.
   * Returns both a flat list (for backward compat with score calculation)
   * and a structured categorized list for the side panel UI.
   */
  function detectAntiBot() {
    const detected = [];
    const detectedStructured = [];
    let score = 0;
    const cookies = document.cookie;

    // Build detection context with helper methods
    const ctx = {
      cookies,
      _headerCache: null,

      hasElement(selector) {
        try {
          return document.querySelector(selector) !== null;
        } catch {
          return false;
        }
      },

      hasScript(pattern) {
        return (
          document.querySelector(`script[src*="${pattern}"]`) !== null
        );
      },

      hasCookie(name) {
        return cookies.includes(name);
      },

      hasGlobal(varName) {
        try {
          // Check common global variable patterns
          const parts = varName.split(".");
          let obj = window;
          for (const part of parts) {
            if (obj == null) return false;
            obj = obj[part];
          }
          return obj !== undefined;
        } catch {
          return false;
        }
      },

      hasHeader(name) {
        // Header data is injected by background.js via chrome.storage
        // and merged into the analysis. The content script checks a
        // cached copy that was stored before analysis ran.
        if (!ctx._headerCache) return false;
        return name.toLowerCase() in ctx._headerCache;
      },

      headerContains(name, substring) {
        if (!ctx._headerCache) return false;
        const val = ctx._headerCache[name.toLowerCase()];
        return val ? val.toLowerCase().includes(substring.toLowerCase()) : false;
      },
    };

    // Load cached headers from storage (set by background.js webRequest listener)
    // This is synchronous because chrome.storage data was pre-loaded.
    try {
      const headerData = window.__alterlabHeaderCache;
      if (headerData && typeof headerData === "object") {
        ctx._headerCache = headerData;
      }
    } catch {
      // No cached headers available — header-based detection will be skipped
    }

    // Track names already detected to avoid duplicates (e.g., Cloudflare WAF + Cloudflare Bot)
    const seenNames = new Set();

    for (const sig of ANTIBOT_SIGNATURES) {
      try {
        let isDetected = sig.detect(ctx);

        // Some detections have a validation step to reduce false positives
        if (isDetected && sig.validate) {
          isDetected = sig.validate(ctx);
        }

        if (isDetected && !seenNames.has(sig.name)) {
          seenNames.add(sig.name);
          detected.push(sig.name);
          score += sig.scoreWeight;
          detectedStructured.push({
            name: sig.name,
            category: sig.category,
            tier: sig.tier,
            technique: sig.technique,
          });
        }
      } catch {
        // Skip individual detection errors
      }
    }

    return { detected, detectedStructured, score };
  }

  /**
   * Detect cookie consent gates and cookie requirements for content access.
   */
  function detectCookieGate() {
    // Cookie consent banners/overlays that block content
    const gateSelectors = [
      "#cookie-consent",
      ".cookie-banner",
      ".cookie-consent",
      ".cookie-wall",
      "[class*='cookie-consent']",
      "[class*='cookieConsent']",
      "[id*='cookie-banner']",
      "[id*='consent-banner']",
      ".gdpr-banner",
      "#gdpr-consent",
      "#onetrust-consent-sdk",
      ".truste-banner",
      "#CybotCookiebotDialog",
      ".cc-banner",
      ".cc-window",
    ];

    for (const sel of gateSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        // Check if it's an overlay/wall (blocks content) vs. a simple banner
        const style = window.getComputedStyle(el);
        const isOverlay =
          style.position === "fixed" ||
          style.position === "absolute" ||
          el.classList.contains("wall") ||
          el.classList.contains("overlay");
        return { detected: true, isOverlay };
      }
    }

    // Check for "accept cookies to continue" text
    const bodyText = (document.body.innerText || "").substring(0, 3000);
    if (
      /accept (all )?cookies to (continue|proceed|access)/i.test(bodyText) ||
      /cookie(s)? (are )?required/i.test(bodyText)
    ) {
      return { detected: true, isOverlay: false };
    }

    return { detected: false, isOverlay: false };
  }

  /**
   * Check if the page is primarily client-side rendered.
   */
  function detectCSR() {
    const bodyText = (document.body.innerText || "").trim();
    const scripts = document.querySelectorAll("script");

    // Detect framework mount points
    const hasReactRoot =
      document.getElementById("root") ||
      document.getElementById("__next") ||
      document.getElementById("app");
    const hasVueApp =
      document.querySelector("[data-v-]") !== null ||
      document.getElementById("__nuxt") !== null;
    const hasAngularApp =
      document.querySelector("[ng-app]") !== null ||
      document.querySelector("[data-ng-app]") !== null ||
      document.querySelector("app-root") !== null;
    const hasSvelteApp = document.querySelector("[data-svelte-h]") !== null;

    // Empty body with many scripts = strong CSR signal
    const hasEmptyBody = bodyText.length < 200 && scripts.length > 5;

    const isCSR =
      hasReactRoot || hasVueApp || hasAngularApp || hasSvelteApp || hasEmptyBody;

    let framework = null;
    if (document.getElementById("__next")) {
      framework = "Next.js";
    } else if (document.getElementById("__nuxt")) {
      framework = "Nuxt.js";
    } else if (hasVueApp) {
      const vueVersion = (typeof window.Vue !== "undefined" && window.Vue.version)
        ? ` ${window.Vue.version}` : "";
      framework = `Vue.js${vueVersion}`;
    } else if (hasAngularApp) {
      framework = "Angular";
    } else if (hasSvelteApp) {
      framework = "Svelte";
    } else if (hasReactRoot) {
      const reactVersion = (typeof window.React !== "undefined" && window.React.version)
        ? ` ${window.React.version}` : "";
      framework = `React${reactVersion}`;
    }

    return { isCSR, framework };
  }

  /**
   * Detect infinite scroll patterns.
   */
  function detectInfiniteScroll() {
    // Check for common infinite scroll libraries/patterns
    const indicators = [
      '[data-infinite-scroll]',
      '.infinite-scroll',
      '[infinite-scroll]',
      '.load-more',
      '#load-more',
      '[data-page]',
    ];

    for (const sel of indicators) {
      if (document.querySelector(sel)) return true;
    }

    return false;
  }

  /**
   * Detect login wall / auth requirement.
   */
  function detectLoginWall() {
    const indicators = [
      'form[action*="login"]',
      'form[action*="signin"]',
      'form[action*="sign-in"]',
      '#login-form',
      '.login-wall',
      '.paywall',
      '[data-login-required]',
    ];

    for (const sel of indicators) {
      if (document.querySelector(sel)) return true;
    }

    // Check for common login-wall text patterns
    const bodyText = (document.body.innerText || "").substring(0, 2000);
    if (
      /sign in to (continue|view|access)/i.test(bodyText) ||
      /log in to (continue|view|access)/i.test(bodyText) ||
      /create an account to/i.test(bodyText)
    ) {
      return true;
    }

    return false;
  }

  /**
   * Detect pagination pattern on the page.
   */
  function detectPagination() {
    // Look for <nav> with pagination role
    const paginationNav = document.querySelector(
      'nav[aria-label*="pagination"], nav[aria-label*="Pagination"], .pagination, [role="navigation"]',
    );

    if (paginationNav) {
      const links = paginationNav.querySelectorAll("a");
      if (links.length > 0) {
        return {
          type: "numbered",
          pages: links.length,
          selector: paginationNav.tagName.toLowerCase() +
            (paginationNav.className ? "." + paginationNav.className.split(" ")[0] : ""),
        };
      }
    }

    // Check for next/prev buttons
    const nextBtn = document.querySelector(
      'a[rel="next"], button[aria-label*="next"], .next-page, a[class*="next"]',
    );
    if (nextBtn) {
      return {
        type: "next-prev",
        pages: null,
        selector: null,
      };
    }

    // Check for load more button
    const loadMore = document.querySelector(
      'button[class*="load-more"], button[class*="show-more"], a[class*="load-more"]',
    );
    if (loadMore) {
      return {
        type: "load-more",
        pages: null,
        selector: null,
      };
    }

    return null;
  }

  /**
   * Detect potential API endpoints from script tags and inline scripts.
   */
  function detectAPIEndpoints() {
    const endpoints = new Set();
    const apiPatterns = [
      /["'](\/api\/v?\d?[^"']*?)["']/g,
      /["'](https?:\/\/[^"']*?\/api\/[^"']*?)["']/g,
      /fetch\(["'](\/[^"']+)["']/g,
    ];

    // Check inline scripts
    const scripts = document.querySelectorAll(
      "script:not([src])",
    );
    for (let i = 0; i < Math.min(scripts.length, 20); i++) {
      const text = scripts[i].textContent || "";
      for (const pattern of apiPatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const endpoint = match[1];
          if (
            endpoint.length < 200 &&
            !endpoint.includes("{{") &&
            !endpoint.includes("${")
          ) {
            endpoints.add(endpoint);
          }
        }
      }
    }

    return Array.from(endpoints).slice(0, 20);
  }

  /**
   * Collect relevant meta tags.
   */
  function collectMeta() {
    const meta = {};
    const tags = document.querySelectorAll("meta");
    const interesting = [
      "description",
      "author",
      "generator",
      "robots",
      "viewport",
    ];

    for (const tag of tags) {
      const name =
        tag.getAttribute("name") || tag.getAttribute("property") || "";
      const content = tag.getAttribute("content") || "";
      if (interesting.includes(name.toLowerCase()) && content) {
        meta[name.toLowerCase()] = content.substring(0, 200);
      }
    }

    // OG tags
    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogTitle) meta["og:title"] = ogTitle.getAttribute("content");
    if (ogDesc) meta["og:description"] = ogDesc.getAttribute("content");

    return meta;
  }

  /**
   * Detect the technology stack of the page across 5 categories:
   * frameworks, CDNs, anti-bot, analytics, and hosting.
   * All detection is client-side via scripts, meta tags, globals, cookies, and DOM.
   */
  function detectTechStack(antiBotList, csrResult) {
    const stack = {
      frameworks: [],
      cdns: [],
      antiBot: [...antiBotList],
      analytics: [],
      hosting: [],
      payments: [],
      chatSupport: [],
      uiLibraries: [],
      emailMarketing: [],
      abTesting: [],
      videoPlayers: [],
    };

    const scripts = document.querySelectorAll("script[src]");
    const scriptSrcs = Array.from(scripts).map((s) => (s.src || "").toLowerCase());
    const allScriptText = scriptSrcs.join(" ");
    const linkHrefs = Array.from(document.querySelectorAll("link[href]"))
      .map((l) => (l.href || "").toLowerCase());
    const metaGenerator = (
      document.querySelector('meta[name="generator"]')?.getAttribute("content") || ""
    ).toLowerCase();
    const cookies = document.cookie;
    const html = document.documentElement.innerHTML;

    // --- Frameworks ---
    // Use CSR result for framework detection already done
    if (csrResult.framework) {
      stack.frameworks.push(csrResult.framework);
    }

    // WordPress
    if (
      metaGenerator.includes("wordpress") ||
      document.querySelector('link[href*="wp-content"]') ||
      document.querySelector('link[href*="wp-includes"]') ||
      scriptSrcs.some((s) => s.includes("wp-content") || s.includes("wp-includes"))
    ) {
      if (!stack.frameworks.includes("WordPress")) {
        stack.frameworks.push("WordPress");
      }
    }

    // Shopify
    if (
      window.Shopify !== undefined ||
      document.querySelector('meta[name="shopify-checkout-api-token"]') ||
      scriptSrcs.some((s) => s.includes("cdn.shopify.com")) ||
      linkHrefs.some((h) => h.includes("cdn.shopify.com"))
    ) {
      if (!stack.frameworks.includes("Shopify")) {
        stack.frameworks.push("Shopify");
      }
    }

    // jQuery (widely used, worth noting) — extract version if available
    if (
      scriptSrcs.some((s) => s.includes("jquery")) ||
      typeof window.jQuery !== "undefined"
    ) {
      const jqVersion = (typeof window.jQuery !== "undefined" && window.jQuery.fn && window.jQuery.fn.jquery)
        ? ` ${window.jQuery.fn.jquery}` : "";
      stack.frameworks.push(`jQuery${jqVersion}`);
    }

    // Gatsby
    if (
      document.getElementById("___gatsby") ||
      scriptSrcs.some((s) => s.includes("gatsby"))
    ) {
      if (!stack.frameworks.includes("Gatsby")) {
        stack.frameworks.push("Gatsby");
      }
    }

    // Remix
    if (document.querySelector('script[type="module"][src*="remix"]') ||
        document.querySelector('meta[name="remix-run"]')) {
      stack.frameworks.push("Remix");
    }

    // Astro
    if (document.querySelector('astro-island') ||
        document.querySelector('[data-astro-cid]')) {
      stack.frameworks.push("Astro");
    }

    // Webflow
    if (
      metaGenerator.includes("webflow") ||
      scriptSrcs.some((s) => s.includes("webflow"))
    ) {
      stack.frameworks.push("Webflow");
    }

    // Wix
    if (
      metaGenerator.includes("wix") ||
      scriptSrcs.some((s) => s.includes("static.parastorage.com") || s.includes("static.wixstatic.com"))
    ) {
      stack.frameworks.push("Wix");
    }

    // Squarespace
    if (
      metaGenerator.includes("squarespace") ||
      scriptSrcs.some((s) => s.includes("squarespace"))
    ) {
      stack.frameworks.push("Squarespace");
    }

    // --- CDNs ---
    // Cloudflare CDN (distinct from Cloudflare anti-bot)
    if (
      scriptSrcs.some((s) => s.includes("cdnjs.cloudflare.com")) ||
      linkHrefs.some((h) => h.includes("cdnjs.cloudflare.com")) ||
      document.querySelector('script[src*="cdn-cgi"]')
    ) {
      stack.cdns.push("Cloudflare CDN");
    }

    // Fastly
    if (scriptSrcs.some((s) => s.includes("fastly")) ||
        linkHrefs.some((h) => h.includes("fastly"))) {
      stack.cdns.push("Fastly");
    }

    // Akamai CDN (distinct from Akamai bot manager)
    if (scriptSrcs.some((s) => s.includes("akamaized.net") || s.includes("akamai.net")) ||
        linkHrefs.some((h) => h.includes("akamaized.net") || h.includes("akamai.net"))) {
      stack.cdns.push("Akamai CDN");
    }

    // CloudFront (AWS)
    if (scriptSrcs.some((s) => s.includes("cloudfront.net")) ||
        linkHrefs.some((h) => h.includes("cloudfront.net"))) {
      stack.cdns.push("CloudFront");
    }

    // Vercel Edge
    if (scriptSrcs.some((s) => s.includes("vercel.app") || s.includes("_vercel")) ||
        document.querySelector('meta[name="x-vercel-id"]')) {
      stack.cdns.push("Vercel");
    }

    // jsDelivr
    if (scriptSrcs.some((s) => s.includes("cdn.jsdelivr.net")) ||
        linkHrefs.some((h) => h.includes("cdn.jsdelivr.net"))) {
      stack.cdns.push("jsDelivr");
    }

    // unpkg
    if (scriptSrcs.some((s) => s.includes("unpkg.com"))) {
      stack.cdns.push("unpkg");
    }

    // Google CDN
    if (scriptSrcs.some((s) => s.includes("ajax.googleapis.com") || s.includes("fonts.googleapis.com")) ||
        linkHrefs.some((h) => h.includes("fonts.googleapis.com") || h.includes("fonts.gstatic.com"))) {
      stack.cdns.push("Google CDN");
    }

    // --- Analytics ---
    // Google Analytics (GA4 / Universal)
    if (
      scriptSrcs.some((s) =>
        s.includes("google-analytics.com") ||
        s.includes("googletagmanager.com") ||
        s.includes("gtag/js")
      ) ||
      typeof window.gtag !== "undefined" ||
      typeof window.ga !== "undefined" ||
      typeof window.dataLayer !== "undefined"
    ) {
      stack.analytics.push("Google Analytics");
    }

    // Google Tag Manager (separate from GA)
    if (
      scriptSrcs.some((s) => s.includes("googletagmanager.com/gtm")) ||
      document.querySelector('noscript iframe[src*="googletagmanager.com"]')
    ) {
      if (!stack.analytics.includes("Google Tag Manager")) {
        stack.analytics.push("Google Tag Manager");
      }
    }

    // Segment
    if (
      scriptSrcs.some((s) => s.includes("cdn.segment.com") || s.includes("segment.io")) ||
      typeof window.analytics !== "undefined"
    ) {
      stack.analytics.push("Segment");
    }

    // Mixpanel
    if (
      scriptSrcs.some((s) => s.includes("cdn.mxpnl.com") || s.includes("mixpanel")) ||
      typeof window.mixpanel !== "undefined"
    ) {
      stack.analytics.push("Mixpanel");
    }

    // Hotjar
    if (
      scriptSrcs.some((s) => s.includes("static.hotjar.com") || s.includes("hotjar")) ||
      typeof window.hj !== "undefined"
    ) {
      stack.analytics.push("Hotjar");
    }

    // Microsoft Clarity
    if (
      scriptSrcs.some((s) => s.includes("clarity.ms")) ||
      typeof window.clarity !== "undefined"
    ) {
      stack.analytics.push("Clarity");
    }

    // Heap
    if (
      scriptSrcs.some((s) => s.includes("heapanalytics") || s.includes("heap-")) ||
      typeof window.heap !== "undefined"
    ) {
      stack.analytics.push("Heap");
    }

    // Amplitude
    if (
      scriptSrcs.some((s) => s.includes("amplitude")) ||
      typeof window.amplitude !== "undefined"
    ) {
      stack.analytics.push("Amplitude");
    }

    // Plausible
    if (scriptSrcs.some((s) => s.includes("plausible.io"))) {
      stack.analytics.push("Plausible");
    }

    // Umami
    if (scriptSrcs.some((s) => s.includes("umami") || s.includes("analytics.js")) &&
        document.querySelector('script[data-website-id]')) {
      stack.analytics.push("Umami");
    }

    // Facebook Pixel
    if (
      scriptSrcs.some((s) => s.includes("connect.facebook.net") || s.includes("fbevents")) ||
      typeof window.fbq !== "undefined"
    ) {
      stack.analytics.push("Facebook Pixel");
    }

    // --- Hosting ---
    // AWS (S3, EC2 indicators)
    if (scriptSrcs.some((s) => s.includes(".amazonaws.com") || s.includes("s3.")) ||
        linkHrefs.some((h) => h.includes(".amazonaws.com"))) {
      stack.hosting.push("AWS");
    }

    // Google Cloud
    if (scriptSrcs.some((s) => s.includes("storage.googleapis.com") || s.includes(".run.app")) ||
        linkHrefs.some((h) => h.includes("storage.googleapis.com"))) {
      stack.hosting.push("Google Cloud");
    }

    // Azure
    if (scriptSrcs.some((s) => s.includes(".azurewebsites.net") || s.includes("azure") || s.includes(".blob.core.windows.net")) ||
        linkHrefs.some((h) => h.includes(".blob.core.windows.net"))) {
      stack.hosting.push("Azure");
    }

    // Vercel (hosting, not just CDN)
    if (
      document.querySelector('meta[name="next-head-count"]') &&
      scriptSrcs.some((s) => s.includes("_next/"))
    ) {
      if (!stack.hosting.includes("Vercel") && !stack.cdns.includes("Vercel")) {
        stack.hosting.push("Vercel");
      }
    }

    // Netlify
    if (
      scriptSrcs.some((s) => s.includes("netlify")) ||
      document.querySelector('meta[name="generator"][content*="Netlify"]') ||
      linkHrefs.some((h) => h.includes("netlify"))
    ) {
      stack.hosting.push("Netlify");
    }

    // Heroku
    if (scriptSrcs.some((s) => s.includes("herokuapp.com"))) {
      stack.hosting.push("Heroku");
    }

    // GitHub Pages
    if (window.location.hostname.endsWith("github.io")) {
      stack.hosting.push("GitHub Pages");
    }

    // Firebase
    if (scriptSrcs.some((s) => s.includes("firebase") || s.includes("firebaseapp.com"))) {
      stack.hosting.push("Firebase");
    }

    // Render
    if (scriptSrcs.some((s) => s.includes(".onrender.com")) ||
        linkHrefs.some((h) => h.includes(".onrender.com"))) {
      stack.hosting.push("Render");
    }

    // Railway
    if (scriptSrcs.some((s) => s.includes(".railway.app")) ||
        linkHrefs.some((h) => h.includes(".railway.app"))) {
      stack.hosting.push("Railway");
    }

    // --- UI Libraries ---
    // Bootstrap (CSS framework)
    if (
      linkHrefs.some((h) => h.includes("bootstrap")) ||
      scriptSrcs.some((s) => s.includes("bootstrap")) ||
      document.querySelector('[class*="btn-primary"],[class*="col-md-"],[class*="navbar-"]') !== null
    ) {
      const bsVersion = (typeof window.bootstrap !== "undefined" && window.bootstrap.Tooltip && window.bootstrap.Tooltip.VERSION)
        ? ` ${window.bootstrap.Tooltip.VERSION}` : "";
      stack.uiLibraries.push(`Bootstrap${bsVersion}`);
    }

    // Tailwind CSS
    if (
      linkHrefs.some((h) => h.includes("tailwind")) ||
      scriptSrcs.some((s) => s.includes("tailwind")) ||
      document.querySelector('[class*="tw-"]') !== null
    ) {
      const twVersion = (typeof window.__TAILWIND_VERSION__ !== "undefined")
        ? ` ${window.__TAILWIND_VERSION__}` : "";
      stack.uiLibraries.push(`Tailwind CSS${twVersion}`);
    }

    // Material UI / MUI
    if (
      scriptSrcs.some((s) => s.includes("material-ui") || s.includes("@mui")) ||
      document.querySelector('[class*="MuiButton"],[class*="MuiBox"],[class*="MuiTypography"]') !== null
    ) {
      stack.uiLibraries.push("Material UI");
    }

    // Ant Design
    if (
      scriptSrcs.some((s) => s.includes("ant-design") || s.includes("antd")) ||
      document.querySelector('[class*="ant-btn"],[class*="ant-col"],[class*="ant-form"]') !== null
    ) {
      stack.uiLibraries.push("Ant Design");
    }

    // Chakra UI
    if (
      scriptSrcs.some((s) => s.includes("chakra-ui") || s.includes("@chakra")) ||
      document.querySelector('[class*="chakra-"]') !== null
    ) {
      stack.uiLibraries.push("Chakra UI");
    }

    // shadcn/ui (uses Radix UI primitives)
    if (
      document.querySelector('[data-radix-collection-item],[data-radix-popper-content-wrapper]') !== null ||
      scriptSrcs.some((s) => s.includes("@radix-ui"))
    ) {
      stack.uiLibraries.push("Radix UI");
    }

    // Bulma CSS
    if (
      linkHrefs.some((h) => h.includes("bulma")) ||
      scriptSrcs.some((s) => s.includes("bulma")) ||
      document.querySelector('[class*="is-primary"],[class*="is-grouped"],[class~="notification"]') !== null
    ) {
      stack.uiLibraries.push("Bulma");
    }

    // Foundation CSS
    if (
      linkHrefs.some((h) => h.includes("foundation")) ||
      scriptSrcs.some((s) => s.includes("foundation")) ||
      document.querySelector('[class*="callout"],[class*="orbit"]') !== null
    ) {
      stack.uiLibraries.push("Foundation");
    }

    // --- Payment Processors ---
    // Stripe
    if (
      scriptSrcs.some((s) => s.includes("js.stripe.com") || s.includes("stripe.js")) ||
      typeof window.Stripe !== "undefined"
    ) {
      stack.payments.push("Stripe");
    }

    // PayPal
    if (
      scriptSrcs.some((s) => s.includes("paypal.com/sdk") || s.includes("paypalobjects.com")) ||
      typeof window.paypal !== "undefined"
    ) {
      stack.payments.push("PayPal");
    }

    // Braintree
    if (
      scriptSrcs.some((s) => s.includes("braintreegateway.com") || s.includes("braintree-web")) ||
      typeof window.braintree !== "undefined"
    ) {
      stack.payments.push("Braintree");
    }

    // Square
    if (
      scriptSrcs.some((s) => s.includes("squareup.com") || s.includes("square.js")) ||
      typeof window.Square !== "undefined"
    ) {
      stack.payments.push("Square");
    }

    // Klarna
    if (
      scriptSrcs.some((s) => s.includes("klarna.com") || s.includes("klarna-payments")) ||
      typeof window.Klarna !== "undefined"
    ) {
      stack.payments.push("Klarna");
    }

    // Adyen
    if (
      scriptSrcs.some((s) => s.includes("adyen.com") || s.includes("adyen-web")) ||
      typeof window.AdyenCheckout !== "undefined"
    ) {
      stack.payments.push("Adyen");
    }

    // Afterpay / Clearpay
    if (
      scriptSrcs.some((s) => s.includes("afterpay.com") || s.includes("clearpay.co.uk"))
    ) {
      stack.payments.push("Afterpay/Clearpay");
    }

    // WooCommerce payments
    if (
      scriptSrcs.some((s) => s.includes("woocommerce-payments") || s.includes("wc-stripe"))
    ) {
      stack.payments.push("WooPayments");
    }

    // --- Chat & Support ---
    // Intercom
    if (
      scriptSrcs.some((s) => s.includes("intercom.io") || s.includes("intercom-cdn")) ||
      typeof window.Intercom !== "undefined"
    ) {
      stack.chatSupport.push("Intercom");
    }

    // Zendesk
    if (
      scriptSrcs.some((s) => s.includes("zdassets.com") || s.includes("zendesk.com/embeddable")) ||
      typeof window.zE !== "undefined" ||
      typeof window.zEmbed !== "undefined"
    ) {
      stack.chatSupport.push("Zendesk");
    }

    // Drift
    if (
      scriptSrcs.some((s) => s.includes("drift.com") || s.includes("js.drift.com")) ||
      typeof window.drift !== "undefined"
    ) {
      stack.chatSupport.push("Drift");
    }

    // Crisp
    if (
      scriptSrcs.some((s) => s.includes("crisp.chat") || s.includes("client.crisp.chat")) ||
      typeof window.$crisp !== "undefined"
    ) {
      stack.chatSupport.push("Crisp");
    }

    // HubSpot Chat
    if (
      scriptSrcs.some((s) => s.includes("hs-scripts.com") || s.includes("hubspot.com/conversations-embed")) ||
      typeof window.HubSpotConversations !== "undefined"
    ) {
      stack.chatSupport.push("HubSpot Chat");
    }

    // LiveChat
    if (
      scriptSrcs.some((s) => s.includes("cdn.livechatinc.com") || s.includes("livechat-static.com")) ||
      typeof window.LiveChatWidget !== "undefined"
    ) {
      stack.chatSupport.push("LiveChat");
    }

    // Freshchat
    if (
      scriptSrcs.some((s) => s.includes("freshchat.com") || s.includes("freshdesk.com/widget")) ||
      typeof window.fcWidget !== "undefined"
    ) {
      stack.chatSupport.push("Freshchat");
    }

    // Tawk.to
    if (
      scriptSrcs.some((s) => s.includes("tawk.to")) ||
      typeof window.Tawk_API !== "undefined"
    ) {
      stack.chatSupport.push("Tawk.to");
    }

    // Help Scout Beacon
    if (
      scriptSrcs.some((s) => s.includes("beacon-v2.helpscout.net")) ||
      typeof window.Beacon !== "undefined"
    ) {
      stack.chatSupport.push("Help Scout");
    }

    // --- Email & Marketing Automation ---
    // Mailchimp
    if (
      scriptSrcs.some((s) => s.includes("mailchimp") || s.includes("chimpstatic.com") || s.includes("list-manage.com"))
    ) {
      stack.emailMarketing.push("Mailchimp");
    }

    // HubSpot (email/CRM)
    if (
      scriptSrcs.some((s) => s.includes("hs-scripts.com") || s.includes("hsforms.net") || s.includes("hubspot.com")) &&
      !stack.chatSupport.includes("HubSpot Chat")
    ) {
      if (!stack.emailMarketing.includes("HubSpot")) {
        stack.emailMarketing.push("HubSpot");
      }
    } else if (
      scriptSrcs.some((s) => s.includes("hs-scripts.com") || s.includes("hsforms.net")) &&
      !stack.emailMarketing.includes("HubSpot")
    ) {
      stack.emailMarketing.push("HubSpot");
    }

    // Klaviyo
    if (
      scriptSrcs.some((s) => s.includes("klaviyo.com") || s.includes("static.klaviyo.com")) ||
      typeof window.klaviyo !== "undefined"
    ) {
      stack.emailMarketing.push("Klaviyo");
    }

    // Marketo
    if (
      scriptSrcs.some((s) => s.includes("marketo.com") || s.includes("mktoweb.com")) ||
      typeof window.MktoForms2 !== "undefined"
    ) {
      stack.emailMarketing.push("Marketo");
    }

    // Pardot / Salesforce Marketing
    if (
      scriptSrcs.some((s) => s.includes("pardot.com") || s.includes("pi.pardot.com"))
    ) {
      stack.emailMarketing.push("Pardot");
    }

    // ActiveCampaign
    if (
      scriptSrcs.some((s) => s.includes("trackcmp.net") || s.includes("activecampaign.com"))
    ) {
      stack.emailMarketing.push("ActiveCampaign");
    }

    // ConvertKit / Kit
    if (
      scriptSrcs.some((s) => s.includes("convertkit.com") || s.includes("ck.js"))
    ) {
      stack.emailMarketing.push("ConvertKit");
    }

    // --- A/B Testing ---
    // Optimizely
    if (
      scriptSrcs.some((s) => s.includes("optimizely.com") || s.includes("cdn.optimizely.com")) ||
      typeof window.optimizely !== "undefined"
    ) {
      stack.abTesting.push("Optimizely");
    }

    // VWO
    if (
      scriptSrcs.some((s) => s.includes("vwo.com") || s.includes("d5phz18u4wuww.cloudfront.net")) ||
      typeof window.VWO !== "undefined" ||
      typeof window._vwo_code !== "undefined"
    ) {
      stack.abTesting.push("VWO");
    }

    // Google Optimize
    if (
      scriptSrcs.some((s) => s.includes("google-analytics.com/optimize.js") || s.includes("googleoptimize.com"))
    ) {
      stack.abTesting.push("Google Optimize");
    }

    // Kameleoon
    if (
      scriptSrcs.some((s) => s.includes("kameleoon.eu") || s.includes("kameleoon.com"))
    ) {
      stack.abTesting.push("Kameleoon");
    }

    // AB Tasty
    if (
      scriptSrcs.some((s) => s.includes("abtasty.com")) ||
      typeof window.ABTasty !== "undefined"
    ) {
      stack.abTesting.push("AB Tasty");
    }

    // LaunchDarkly
    if (
      scriptSrcs.some((s) => s.includes("launchdarkly.com")) ||
      typeof window.ldClient !== "undefined"
    ) {
      stack.abTesting.push("LaunchDarkly");
    }

    // Statsig
    if (
      scriptSrcs.some((s) => s.includes("statsig.com")) ||
      typeof window.statsig !== "undefined"
    ) {
      stack.abTesting.push("Statsig");
    }

    // PostHog (feature flags + analytics)
    if (
      scriptSrcs.some((s) => s.includes("posthog.com") || s.includes("us.i.posthog.com")) ||
      typeof window.posthog !== "undefined"
    ) {
      stack.abTesting.push("PostHog");
    }

    // --- Video Players ---
    // YouTube embeds
    if (
      document.querySelector('iframe[src*="youtube.com/embed"], iframe[src*="youtu.be"]') !== null ||
      scriptSrcs.some((s) => s.includes("youtube.com/iframe_api") || s.includes("youtube.com/player_api"))
    ) {
      stack.videoPlayers.push("YouTube");
    }

    // Vimeo
    if (
      document.querySelector('iframe[src*="vimeo.com"]') !== null ||
      scriptSrcs.some((s) => s.includes("player.vimeo.com") || s.includes("vimeo.js"))
    ) {
      stack.videoPlayers.push("Vimeo");
    }

    // Wistia
    if (
      scriptSrcs.some((s) => s.includes("wistia.com") || s.includes("wistia.net")) ||
      typeof window.Wistia !== "undefined"
    ) {
      stack.videoPlayers.push("Wistia");
    }

    // Mux
    if (
      scriptSrcs.some((s) => s.includes("mux.com") || s.includes("mux-embed"))
    ) {
      stack.videoPlayers.push("Mux");
    }

    // Vidyard
    if (
      scriptSrcs.some((s) => s.includes("vidyard.com")) ||
      typeof window.vidyardEmbed !== "undefined"
    ) {
      stack.videoPlayers.push("Vidyard");
    }

    // JW Player
    if (
      scriptSrcs.some((s) => s.includes("jwplayer.com") || s.includes("content.jwplatform.com")) ||
      typeof window.jwplayer !== "undefined"
    ) {
      stack.videoPlayers.push("JW Player");
    }

    // Brightcove
    if (
      scriptSrcs.some((s) => s.includes("brightcove.com") || s.includes("brightcovecdn.com"))
    ) {
      stack.videoPlayers.push("Brightcove");
    }

    return stack;
  }

  // --- Message handling ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "LOCAL_TOOLS_SNAPSHOT") {
      // Read-only page snapshot for the side panel's local tools. Cookie
      // names only (document.cookie never exposes HttpOnly values anyway).
      try {
        sendResponse({
          url: location.href,
          html: document.documentElement.outerHTML.slice(0, 5000000),
          scripts: Array.from(document.scripts, (s) => s.src).filter(Boolean),
          cookies: document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean),
          resources: performance
            .getEntriesByType("resource")
            .map((r) => ({ url: r.name, type: r.initiatorType })),
        });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return false;
    }

    if (message.type === "ANALYZE_PAGE") {
      try {
        const analysis = analyzePage();
        sendResponse(analysis);
      } catch (err) {
        sendResponse({ error: err.message, score: 0, signals: [] });
      }
      return false;
    }

    if (message.type === "GET_ELEMENT_SELECTOR") {
      // Used by context menu "Copy selector" — returns a CSS selector for the
      // element at the right-click position. The coordinates come from the
      // background script's contextMenus.onClicked info.
      sendResponse({ selector: null }); // placeholder — context menu coords are limited
      return false;
    }

    if (message.type === "SELECTOR_ACTIVATE") {
      selectorBuilder.activate();
      sendResponse({ status: "ok" });
      return false;
    }

    if (message.type === "SELECTOR_DEACTIVATE") {
      selectorBuilder.deactivate();
      sendResponse({ status: "ok" });
      return false;
    }

    if (message.type === "SELECTOR_TEST") {
      const result = selectorBuilder.testSelector(message.selector, message.selectorType);
      sendResponse(result);
      return false;
    }

    if (message.type === "SELECTOR_CLEAR_HIGHLIGHTS") {
      selectorBuilder.clearTestHighlights();
      sendResponse({ status: "ok" });
      return false;
    }
  });

  // ---------------------------------------------------------------------------
  // Selector Builder — Point-and-Click CSS/XPath Selector Generator
  // ---------------------------------------------------------------------------

  const selectorBuilder = (() => {
    let active = false;
    let hoveredElement = null;
    let overlayEl = null;
    let tooltipEl = null;
    let testHighlights = [];

    // --- Smart CSS Selector Generation ---

    /**
     * Generate a smart CSS selector for an element, preferring reliable
     * attributes over fragile positional selectors.
     *
     * Priority: id > data-* > unique class combo > tag.class > nth-child chain
     */
    function generateCssSelector(el) {
      if (!el || el === document.body || el === document.documentElement) {
        return { selector: el ? el.tagName.toLowerCase() : "body", reliability: 0 };
      }

      // 1. ID — most reliable
      if (el.id && /^[a-zA-Z]/.test(el.id) && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
        return { selector: `#${CSS.escape(el.id)}`, reliability: 100 };
      }

      // 2. data-* attributes — typically stable
      for (const attr of el.attributes) {
        if (attr.name.startsWith("data-") && attr.value &&
            attr.name !== "data-alterlab" && attr.name !== "data-alterlab-highlight") {
          const sel = `${el.tagName.toLowerCase()}[${attr.name}="${CSS.escape(attr.value)}"]`;
          try {
            if (document.querySelectorAll(sel).length === 1) {
              return { selector: sel, reliability: 90 };
            }
          } catch { /* invalid selector */ }
        }
      }

      // 3. aria-label — accessible and stable
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) {
        const sel = `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
        try {
          if (document.querySelectorAll(sel).length === 1) {
            return { selector: sel, reliability: 85 };
          }
        } catch { /* invalid selector */ }
      }

      // 4. name attribute (for form elements)
      const name = el.getAttribute("name");
      if (name) {
        const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        try {
          if (document.querySelectorAll(sel).length === 1) {
            return { selector: sel, reliability: 85 };
          }
        } catch { /* invalid selector */ }
      }

      // 5. Unique class combination
      if (el.classList.length > 0) {
        const classes = Array.from(el.classList)
          .filter(c => c.length > 0 && !c.includes(":") && !/^[\d]/.test(c) && c.length < 50);

        // Try single class first
        for (const cls of classes) {
          const sel = `${el.tagName.toLowerCase()}.${CSS.escape(cls)}`;
          try {
            if (document.querySelectorAll(sel).length === 1) {
              return { selector: sel, reliability: 75 };
            }
          } catch { /* invalid selector */ }
        }

        // Try class pairs
        for (let i = 0; i < classes.length; i++) {
          for (let j = i + 1; j < classes.length && j < i + 4; j++) {
            const sel = `${el.tagName.toLowerCase()}.${CSS.escape(classes[i])}.${CSS.escape(classes[j])}`;
            try {
              if (document.querySelectorAll(sel).length === 1) {
                return { selector: sel, reliability: 70 };
              }
            } catch { /* invalid selector */ }
          }
        }
      }

      // 6. Tag with parent context (up to 3 levels)
      const path = [];
      let current = el;
      let depth = 0;
      while (current && current !== document.body && depth < 4) {
        let segment = current.tagName.toLowerCase();
        if (current.id && /^[a-zA-Z]/.test(current.id)) {
          segment = `#${CSS.escape(current.id)}`;
          path.unshift(segment);
          break;
        }
        if (current.classList.length > 0) {
          const cls = Array.from(current.classList)
            .filter(c => c.length > 0 && !c.includes(":") && c.length < 50)
            .slice(0, 2)
            .map(c => `.${CSS.escape(c)}`)
            .join("");
          if (cls) segment += cls;
        }
        path.unshift(segment);
        current = current.parentElement;
        depth++;
      }

      const contextSel = path.join(" > ");
      try {
        const count = document.querySelectorAll(contextSel).length;
        if (count === 1) {
          return { selector: contextSel, reliability: Math.max(30, 60 - depth * 10) };
        }
      } catch { /* invalid selector */ }

      // 7. nth-child fallback — fragile but always works
      const nthPath = [];
      current = el;
      while (current && current !== document.body) {
        const parent = current.parentElement;
        if (!parent) break;
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        const index = siblings.indexOf(current) + 1;
        const tag = current.tagName.toLowerCase();
        if (siblings.length === 1) {
          nthPath.unshift(tag);
        } else {
          nthPath.unshift(`${tag}:nth-of-type(${index})`);
        }
        if (parent.id && /^[a-zA-Z]/.test(parent.id)) {
          nthPath.unshift(`#${CSS.escape(parent.id)}`);
          break;
        }
        current = parent;
        if (nthPath.length > 5) break;
      }

      return { selector: nthPath.join(" > "), reliability: 15 };
    }

    /**
     * Generate an XPath expression for an element.
     */
    function generateXPath(el) {
      if (!el) return "";
      if (el === document.body) return "/html/body";
      if (el === document.documentElement) return "/html";

      // ID shortcut
      if (el.id && /^[a-zA-Z]/.test(el.id)) {
        return `//*[@id="${el.id}"]`;
      }

      // data-* attribute shortcut
      for (const attr of el.attributes) {
        if (attr.name.startsWith("data-") && attr.value &&
            attr.name !== "data-alterlab" && attr.name !== "data-alterlab-highlight") {
          const xpath = `//${el.tagName.toLowerCase()}[@${attr.name}="${attr.value}"]`;
          try {
            const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            if (result.snapshotLength === 1) return xpath;
          } catch { /* invalid xpath */ }
        }
      }

      // Build positional path
      const parts = [];
      let current = el;
      while (current && current !== document) {
        const tag = current.tagName.toLowerCase();
        if (current.id && /^[a-zA-Z]/.test(current.id)) {
          parts.unshift(`//*[@id="${current.id}"]`);
          break;
        }
        const parent = current.parentElement || current.parentNode;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
          if (siblings.length > 1) {
            const index = siblings.indexOf(current) + 1;
            parts.unshift(`${tag}[${index}]`);
          } else {
            parts.unshift(tag);
          }
        } else {
          parts.unshift(tag);
        }
        current = parent;
        if (parts.length > 8) break;
      }

      const xpath = parts[0] && parts[0].startsWith("//*") ? parts.join("/") : "/" + parts.join("/");
      return xpath;
    }

    /**
     * Compute a reliability label from a numeric score.
     */
    function reliabilityLabel(score) {
      if (score >= 85) return "Excellent";
      if (score >= 65) return "Good";
      if (score >= 40) return "Fair";
      return "Fragile";
    }

    function reliabilityColor(score) {
      if (score >= 85) return "#22c55e";
      if (score >= 65) return "#6366f1";
      if (score >= 40) return "#f59e0b";
      return "#ef4444";
    }

    // --- Overlay & Tooltip ---

    function createOverlay() {
      if (overlayEl) return;
      overlayEl = document.createElement("div");
      overlayEl.setAttribute("data-alterlab", "selector-overlay");
      Object.assign(overlayEl.style, {
        position: "fixed",
        pointerEvents: "none",
        border: "2px solid #6366f1",
        backgroundColor: "rgba(99, 102, 241, 0.08)",
        borderRadius: "3px",
        zIndex: "2147483646",
        transition: "all 0.08s ease-out",
        display: "none",
      });
      document.documentElement.appendChild(overlayEl);

      tooltipEl = document.createElement("div");
      tooltipEl.setAttribute("data-alterlab", "selector-tooltip");
      Object.assign(tooltipEl.style, {
        position: "fixed",
        pointerEvents: "none",
        zIndex: "2147483647",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        fontSize: "11px",
        lineHeight: "1.4",
        color: "#fafaf9",
        backgroundColor: "#1c1917",
        border: "1px solid #44403c",
        borderRadius: "6px",
        padding: "6px 10px",
        maxWidth: "360px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
        display: "none",
        whiteSpace: "nowrap",
      });
      document.documentElement.appendChild(tooltipEl);
    }

    function removeOverlay() {
      if (overlayEl) { overlayEl.remove(); overlayEl = null; }
      if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
    }

    function positionOverlay(el) {
      if (!overlayEl || !el) return;
      const rect = el.getBoundingClientRect();
      Object.assign(overlayEl.style, {
        left: rect.left + "px",
        top: rect.top + "px",
        width: rect.width + "px",
        height: rect.height + "px",
        display: "block",
      });
    }

    function positionTooltip(el) {
      if (!tooltipEl || !el) return;

      const tag = el.tagName.toLowerCase();
      const classes = el.classList.length > 0
        ? "." + Array.from(el.classList).slice(0, 3).join(".")
        : "";
      const id = el.id ? `#${el.id}` : "";
      const rect = el.getBoundingClientRect();
      const dims = `${Math.round(rect.width)}\u00D7${Math.round(rect.height)}`;

      tooltipEl.innerHTML = `<span style="color:#818cf8;font-weight:600;">&lt;${tag}&gt;</span>` +
        (id ? `<span style="color:#22c55e;margin-left:4px;">${id}</span>` : "") +
        (classes ? `<span style="color:#a8a29e;margin-left:4px;">${classes}</span>` : "") +
        `<span style="color:#78716c;margin-left:8px;">${dims}</span>`;
      tooltipEl.style.display = "block";

      // Position below the element, or above if near bottom
      const tipRect = tooltipEl.getBoundingClientRect();
      let top = rect.bottom + 6;
      let left = rect.left;

      if (top + tipRect.height > window.innerHeight) {
        top = rect.top - tipRect.height - 6;
      }
      if (left + tipRect.width > window.innerWidth) {
        left = window.innerWidth - tipRect.width - 8;
      }
      if (left < 4) left = 4;
      if (top < 4) top = 4;

      tooltipEl.style.top = top + "px";
      tooltipEl.style.left = left + "px";
    }

    // --- Event Handlers ---

    function onMouseMove(e) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === overlayEl || el === tooltipEl ||
          el.hasAttribute("data-alterlab") || el === document.documentElement || el === document.body) {
        return;
      }
      if (el === hoveredElement) return;
      hoveredElement = el;
      positionOverlay(el);
      positionTooltip(el);
    }

    function onClick(e) {
      if (!active || !hoveredElement) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const el = hoveredElement;
      const css = generateCssSelector(el);
      const xpath = generateXPath(el);
      const rect = el.getBoundingClientRect();

      // Send to side panel via background
      chrome.runtime.sendMessage({
        type: "SELECTOR_PICKED",
        css: css.selector,
        xpath: xpath,
        reliability: css.reliability,
        reliabilityLabel: reliabilityLabel(css.reliability),
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: Array.from(el.classList).slice(0, 5),
        text: (el.textContent || "").trim().slice(0, 80),
        dimensions: { width: Math.round(rect.width), height: Math.round(rect.height) },
      });
    }

    function onKeyDown(e) {
      if (e.key === "Escape") {
        // Notify side panel that user pressed Escape to deactivate
        chrome.runtime.sendMessage({ type: "SELECTOR_ESCAPED" });
        deactivate();
      }
    }

    // --- Test Selector ---

    function testSelector(selector, selectorType) {
      clearTestHighlights();
      let matches = [];
      try {
        if (selectorType === "xpath") {
          const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < result.snapshotLength; i++) {
            matches.push(result.snapshotItem(i));
          }
        } else {
          matches = Array.from(document.querySelectorAll(selector));
        }
      } catch {
        return { count: 0, error: "Invalid selector" };
      }

      // Highlight all matches
      for (const m of matches) {
        if (!(m instanceof HTMLElement)) continue;
        const highlight = document.createElement("div");
        highlight.setAttribute("data-alterlab-highlight", "test");
        const rect = m.getBoundingClientRect();
        Object.assign(highlight.style, {
          position: "absolute",
          left: rect.left + window.scrollX + "px",
          top: rect.top + window.scrollY + "px",
          width: rect.width + "px",
          height: rect.height + "px",
          border: "2px solid #22c55e",
          backgroundColor: "rgba(34, 197, 94, 0.12)",
          borderRadius: "2px",
          pointerEvents: "none",
          zIndex: "2147483645",
          transition: "opacity 0.2s",
        });
        document.documentElement.appendChild(highlight);
        testHighlights.push(highlight);
      }

      // Scroll first match into view
      if (matches.length > 0 && matches[0] instanceof HTMLElement) {
        matches[0].scrollIntoView({ behavior: "smooth", block: "center" });
      }

      return { count: matches.length, error: null };
    }

    function clearTestHighlights() {
      for (const h of testHighlights) h.remove();
      testHighlights = [];
      // Also remove any orphaned highlights
      document.querySelectorAll("[data-alterlab-highlight]").forEach(h => h.remove());
    }

    // --- Activate / Deactivate ---

    function activate() {
      if (active) return;
      active = true;
      createOverlay();
      document.addEventListener("mousemove", onMouseMove, true);
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKeyDown, true);
      // Prevent default click behavior
      document.addEventListener("mousedown", preventDefault, true);
      document.addEventListener("mouseup", preventDefault, true);
    }

    function deactivate() {
      if (!active) return;
      active = false;
      hoveredElement = null;
      removeOverlay();
      clearTestHighlights();
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", preventDefault, true);
      document.removeEventListener("mouseup", preventDefault, true);
    }

    function preventDefault(e) {
      if (!active) return;
      e.preventDefault();
      e.stopPropagation();
    }

    return { activate, deactivate, testSelector, clearTestHighlights };
  })();

  // ---------------------------------------------------------------------------
  // Network Request Interception
  // ---------------------------------------------------------------------------

  /**
   * Inject a page-context script to monkey-patch fetch() and XMLHttpRequest.
   * Content scripts run in an isolated world and cannot see page-initiated
   * network calls — the injected script runs in the page's JS context and
   * posts intercepted request data back via window.postMessage.
   */
  function injectNetworkInterceptor() {
    const script = document.createElement("script");
    script.textContent = `(${function () {
      const ALTERLAB_MSG_TYPE = "__ALTERLAB_NET_REQ__";

      // Skip binary / non-data content types
      const SKIP_CONTENT_TYPES = [
        "image/",
        "font/",
        "audio/",
        "video/",
        "text/css",
        "text/html",
        "application/javascript",
        "application/x-javascript",
        "text/javascript",
        "application/wasm",
        "application/octet-stream",
      ];

      function shouldCapture(contentType, url) {
        if (!contentType && !url) return false;
        const ct = (contentType || "").toLowerCase();
        // Always capture JSON and GraphQL
        if (ct.includes("json") || ct.includes("graphql")) return true;
        // Skip known non-data types
        for (const skip of SKIP_CONTENT_TYPES) {
          if (ct.startsWith(skip)) return false;
        }
        // URL heuristics — likely API endpoints
        const u = (url || "").toLowerCase();
        if (
          u.includes("/api/") ||
          u.includes("/graphql") ||
          u.includes("/v1/") ||
          u.includes("/v2/") ||
          u.includes("/v3/") ||
          u.includes(".json") ||
          u.includes("/search") ||
          u.includes("/query")
        ) {
          return true;
        }
        // If content type is set and not skipped, capture it
        if (ct && !SKIP_CONTENT_TYPES.some((s) => ct.startsWith(s))) {
          return true;
        }
        return false;
      }

      function truncateBody(text, limit) {
        if (!text) return "";
        if (text.length <= limit) return text;
        return text.substring(0, limit) + "...";
      }

      function classifyData(body, url) {
        if (!body) return null;
        const text = typeof body === "string" ? body : JSON.stringify(body);
        const lower = text.toLowerCase();
        const urlLower = (url || "").toLowerCase();

        // Product / e-commerce
        if (
          /\b(price|sku|product_?id|add_?to_?cart|inventory|variant)\b/.test(lower) ||
          /\b(products?|items?|catalog)\b/.test(urlLower)
        ) {
          return "products";
        }
        // Pricing
        if (
          /\b(price|cost|discount|coupon|promo|pricing)\b/.test(lower) &&
          /\b(plan|tier|subscription|monthly|annual)\b/.test(lower)
        ) {
          return "pricing";
        }
        // Listings / search results
        if (
          /\b(results|listings|hits|matches|total_?count|page_?size)\b/.test(lower) ||
          /\b(search|listing|browse)\b/.test(urlLower)
        ) {
          return "listings";
        }
        // Articles / blog
        if (
          /\b(article|post|author|published|content|blog|headline)\b/.test(lower) ||
          /\b(articles?|posts?|blog|news)\b/.test(urlLower)
        ) {
          return "articles";
        }
        // Reviews
        if (
          /\b(review|rating|stars|feedback|comment|testimonial)\b/.test(lower) ||
          /\b(reviews?|ratings?|comments?)\b/.test(urlLower)
        ) {
          return "reviews";
        }
        // Users / profiles
        if (
          /\b(user|profile|account|member|avatar)\b/.test(lower) ||
          /\b(users?|profiles?|members?)\b/.test(urlLower)
        ) {
          return "users";
        }
        // GraphQL
        if (urlLower.includes("graphql") || /\b(query|mutation|__typename)\b/.test(lower)) {
          return "graphql";
        }
        return "data";
      }

      function postRequest(entry) {
        try {
          window.postMessage({ type: ALTERLAB_MSG_TYPE, entry }, "*");
        } catch {
          // Serialization error — skip
        }
      }

      // --- Patch fetch ---
      const origFetch = window.fetch;
      window.fetch = function (...args) {
        const startTime = performance.now();
        const request = args[0];
        let method = "GET";
        let url = "";

        if (typeof request === "string") {
          url = request;
        } else if (request instanceof Request) {
          url = request.url;
          method = request.method || "GET";
        }
        if (args[1] && args[1].method) {
          method = args[1].method;
        }

        // Resolve relative URLs
        try {
          url = new URL(url, window.location.origin).href;
        } catch {
          // keep as-is
        }

        return origFetch.apply(this, args).then(
          (response) => {
            const elapsed = Math.round(performance.now() - startTime);
            const ct = response.headers.get("content-type") || "";

            if (shouldCapture(ct, url)) {
              // Clone so the original stream is not consumed
              response
                .clone()
                .text()
                .then((bodyText) => {
                  postRequest({
                    id: Date.now() + "_" + Math.random().toString(36).slice(2, 8),
                    method: method.toUpperCase(),
                    url,
                    status: response.status,
                    statusText: response.statusText,
                    contentType: ct,
                    responseSize: bodyText.length,
                    responseTime: elapsed,
                    body: truncateBody(bodyText, 2000),
                    dataType: classifyData(bodyText, url),
                    timestamp: Date.now(),
                    source: "fetch",
                  });
                })
                .catch(() => {
                  // Body not readable — still log metadata
                  postRequest({
                    id: Date.now() + "_" + Math.random().toString(36).slice(2, 8),
                    method: method.toUpperCase(),
                    url,
                    status: response.status,
                    statusText: response.statusText,
                    contentType: ct,
                    responseSize: 0,
                    responseTime: elapsed,
                    body: "",
                    dataType: null,
                    timestamp: Date.now(),
                    source: "fetch",
                  });
                });
            }
            return response;
          },
          (err) => {
            // Network error
            const elapsed = Math.round(performance.now() - startTime);
            if (shouldCapture("", url)) {
              postRequest({
                id: Date.now() + "_" + Math.random().toString(36).slice(2, 8),
                method: method.toUpperCase(),
                url,
                status: 0,
                statusText: "Network Error",
                contentType: "",
                responseSize: 0,
                responseTime: elapsed,
                body: "",
                dataType: null,
                timestamp: Date.now(),
                source: "fetch",
              });
            }
            throw err;
          },
        );
      };

      // --- Patch XMLHttpRequest ---
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._alterlabMethod = (method || "GET").toUpperCase();
        try {
          this._alterlabUrl = new URL(url, window.location.origin).href;
        } catch {
          this._alterlabUrl = String(url);
        }
        return origOpen.call(this, method, url, ...rest);
      };

      XMLHttpRequest.prototype.send = function (body) {
        const startTime = performance.now();
        const method = this._alterlabMethod || "GET";
        const url = this._alterlabUrl || "";

        this.addEventListener("load", function () {
          const elapsed = Math.round(performance.now() - startTime);
          const ct =
            this.getResponseHeader("content-type") || "";

          if (shouldCapture(ct, url)) {
            const bodyText =
              typeof this.responseText === "string" ? this.responseText : "";
            postRequest({
              id: Date.now() + "_" + Math.random().toString(36).slice(2, 8),
              method,
              url,
              status: this.status,
              statusText: this.statusText,
              contentType: ct,
              responseSize: bodyText.length,
              responseTime: elapsed,
              body: truncateBody(bodyText, 2000),
              dataType: classifyData(bodyText, url),
              timestamp: Date.now(),
              source: "xhr",
            });
          }
        });

        this.addEventListener("error", function () {
          const elapsed = Math.round(performance.now() - startTime);
          if (shouldCapture("", url)) {
            postRequest({
              id: Date.now() + "_" + Math.random().toString(36).slice(2, 8),
              method,
              url,
              status: 0,
              statusText: "Network Error",
              contentType: "",
              responseSize: 0,
              responseTime: elapsed,
              body: "",
              dataType: null,
              timestamp: Date.now(),
              source: "xhr",
            });
          }
        });

        return origSend.call(this, body);
      };
    }.toString()})();`;
    script.setAttribute("data-alterlab", "network-interceptor");
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  // Listen for intercepted requests from the page-context script
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      !event.data ||
      event.data.type !== "__ALTERLAB_NET_REQ__"
    ) {
      return;
    }

    // Forward to background service worker for storage
    chrome.runtime.sendMessage({
      type: "NETWORK_REQUEST",
      domain: window.location.hostname,
      entry: event.data.entry,
    });
  });

  const ALTERLAB_ORIGINS = [
    "https://alterlab.io",
    "https://www.alterlab.io",
    "http://localhost:3000",
    "http://localhost",
  ];

  // --- AlterLab Connect v2: agent connect request from the dashboard (#38934) ---
  // The dashboard asks to connect one site; the extension shows its own consent
  // prompt and replies with a session id only, never cookie data.
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type !== "ALTERLAB_CONNECT_REQUEST") return;
    const pageOrigin = window.location.origin;
    if (!ALTERLAB_ORIGINS.includes(pageOrigin)) return;

    const { site, scopes, agent, accessMode, correlationId } = event.data;
    const reply = (payload) =>
      window.postMessage({ ...payload, site, correlationId }, pageOrigin);
    if (!site || typeof site !== "string") {
      reply({ type: "ALTERLAB_CONNECT_ERROR", error: "Invalid site" });
      return;
    }
    chrome.runtime.sendMessage(
      { type: "CONNECT_REQUEST", request: { site, scopes, agent, accessMode } },
      (response) => {
        if (chrome.runtime.lastError || !response || response.error) {
          reply({
            type: "ALTERLAB_CONNECT_ERROR",
            error:
              (response && response.error) ||
              (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
              "Extension error",
          });
          return;
        }
        reply({ type: "ALTERLAB_CONNECTED", session_id: response.session_id, scopes: response.scopes });
      },
    );
  });

  // Inject the interceptor early
  injectNetworkInterceptor();
})();
