/**
 * AlterLab Connect - Side Panel Script
 *
 * Primary extension surface with tabbed navigation:
 * - Inspect: Scrape score, anti-bot detection, signals, API endpoints
 * - Scrape: One-click page extraction + Advanced API job submission
 * - Meta: SEO tag analyzer with OG/Twitter/JSON-LD support
 * - Robots: robots.txt viewer, crawl checker, sitemap explorer
 * - Cookies: Full cookie inspector + Send to AlterLab (capture)
 * - Network: API request monitor + Request headers viewer
 * - Selector: Point-and-click CSS/XPath selector builder with reliability scoring
 * - Account: AlterLab connection, credits, saved sessions
 */

// State
let currentAnalysis = null;
let analysisResolved = false;
let currentCookies = [];
let selectedCookieKeys = new Set();
let currentDomain = "";
let currentUrl = "";

// Cookie Inspector state
let ciAllCookies = [];
let ciSearchQuery = "";
let ciSortField = "name"; // name, domain, expiry, size
let ciSortAsc = true;
let ciActiveFilter = "all"; // all, auth, secure, httponly, expired, session

// Tab navigation state — default to Scrape tab (index 1)
let currentTabIndex = 1;
let previousScore = null;

// Headers tab state
let hdrAllRequests = [];
let hdrSearchQuery = "";
let hdrActiveFilter = "all"; // all, xhr, document, script, stylesheet, image, font, other
let hdrCurrentTabId = null;

// Selector builder state
let selActive = false;
let selSelectors = []; // { id, css, xpath, reliability, reliabilityLabel, tag, classes, text, dimensions, fieldName }

// DOM references — populated after DOMContentLoaded
let els = {};

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  bindTabNavigation();
  bindCookieInspectorEvents();
  bindHeadersEvents();
  bindCaptureEvents();
  bindAccountEvents();
  bindJobEvents();
  bindScrapeEvents();
  bindExportEvents();
  bindRobotsEvents();
  bindSelectorEvents();
  bindOnboardingCarousel();
  bindTourLinks();
  bindInlineAuthPrompts();

  // Get active tab info
  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (tab && tab.url) {
    try {
      const url = new URL(tab.url);
      currentDomain = url.hostname;
      currentUrl = tab.url;
      els.domainPill.textContent = currentDomain;
      els.jobUrl.value = currentUrl;
    } catch {
      currentDomain = "";
      currentUrl = "";
    }
  }

  // Offline detection
  bindOfflineDetection();

  // Load account state and gate on auth
  const isAuthenticated = await loadAccountState();

  if (!isAuthenticated) {
    // No API key and no auto-detected session — switch to Account tab
    // so the user sees the login prompt immediately
    switchToTab("account");
  }

  // Re-check auth when side panel regains visibility (e.g., user returns
  // from the AlterLab login page in another tab)
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible") {
      const wasAuthenticated = !!(await loadConfig()).apiKey;
      const nowAuthenticated = await loadAccountState();

      if (!wasAuthenticated && nowAuthenticated) {
        // Just became authenticated — switch to Inspect tab and refresh analysis
        switchToTab("inspect");
        showToast("success", "Welcome!", "You're signed in. Analyzing page...", { duration: 3000 });

        // Re-run page analysis now that we're authenticated
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (activeTab && activeTab.id && currentDomain) {
          requestPageAnalysis(activeTab.id);
        }
      }
    }
  });

  // Check if onboarding carousel should show
  await maybeShowOnboarding();

  // Request page analysis from content script
  if (tab && tab.id && currentDomain) {
    hdrCurrentTabId = tab.id;
    requestPageAnalysis(tab.id);
    loadCookies();
    loadInspectorCookies();
    loadNetworkRequests();
  }

  // Safety-net timeout: if analysis never resolves (e.g., chrome:// page,
  // content script not injected, first load after install), stop the
  // "Analyzing..." pulse and show a clear error state after 8 seconds.
  setTimeout(() => {
    if (!analysisResolved) {
      analysisResolved = true;
      renderInspectError("Unavailable \u2014 refresh the page");
    }
  }, 8000);
});

function cacheElements() {
  els = {
    domainPill: document.getElementById("domainPill"),
    // Inspect
    scoreRing: document.getElementById("scoreRing"),
    scoreValue: document.getElementById("scoreValue"),
    scoreSkeleton: document.getElementById("scoreSkeleton"),
    scoreDifficulty: document.getElementById("scoreDifficulty"),
    scoreDescription: document.getElementById("scoreDescription"),
    antiBotStack: document.getElementById("antiBotStack"),
    antiBotCount: document.getElementById("antiBotCount"),
    antiBotCard: document.getElementById("antiBotCard"),
    signalList: document.getElementById("signalList"),
    signalCount: document.getElementById("signalCount"),
    signalsCard: document.getElementById("signalsCard"),
    paginationCard: document.getElementById("paginationCard"),
    paginationInfo: document.getElementById("paginationInfo"),
    apiCard: document.getElementById("apiCard"),
    apiCount: document.getElementById("apiCount"),
    apiEndpointList: document.getElementById("apiEndpointList"),
    // Tech Stack
    techStackCard: document.getElementById("techStackCard"),
    techStackCount: document.getElementById("techStackCount"),
    techStackBody: document.getElementById("techStackBody"),
    // Conversion hook
    conversionHook: document.getElementById("conversionHook"),
    hookTitle: document.getElementById("hookTitle"),
    hookBody: document.getElementById("hookBody"),
    hookTierBadge: document.getElementById("hookTierBadge"),
    hookStack: document.getElementById("hookStack"),
    // Cookie Inspector
    ciTotalCount: document.getElementById("ciTotalCount"),
    ciAuthCount: document.getElementById("ciAuthCount"),
    ciExpiredCount: document.getElementById("ciExpiredCount"),
    ciTotalSize: document.getElementById("ciTotalSize"),
    ciSearchInput: document.getElementById("ciSearchInput"),
    ciSortBtn: document.getElementById("ciSortBtn"),
    ciSubdomains: document.getElementById("ciSubdomains"),
    ciCookieList: document.getElementById("ciCookieList"),
    ciResultCount: document.getElementById("ciResultCount"),
    ciExportJson: document.getElementById("ciExportJson"),
    ciExportNetscape: document.getElementById("ciExportNetscape"),
    ciExportKV: document.getElementById("ciExportKV"),
    ciBulkDelete: document.getElementById("ciBulkDelete"),
    ciFilteredInfo: document.getElementById("ciFilteredInfo"),
    ciStatus: document.getElementById("ciStatus"),
    // Headers
    hdrRequestCount: document.getElementById("hdrRequestCount"),
    hdrRequestCountInner: document.getElementById("hdrRequestCountInner"),
    hdrClearBtn: document.getElementById("hdrClearBtn"),
    hdrSearchInput: document.getElementById("hdrSearchInput"),
    hdrFilters: document.getElementById("hdrFilters"),
    hdrFilteredCount: document.getElementById("hdrFilteredCount"),
    hdrRequestList: document.getElementById("hdrRequestList"),
    hdrStatus: document.getElementById("hdrStatus"),
    // Capture
    cookieCountBadge: document.getElementById("cookieCountBadge"),
    cookieList: document.getElementById("cookieList"),
    sessionName: document.getElementById("sessionName"),
    captureBtn: document.getElementById("captureBtn"),
    openDashboardBtn: document.getElementById("openDashboardBtn"),
    copyBtn: document.getElementById("copyBtn"),
    captureStatus: document.getElementById("captureStatus"),
    selectAllBtn: document.getElementById("selectAllBtn"),
    selectNoneBtn: document.getElementById("selectNoneBtn"),
    selectAuthBtn: document.getElementById("selectAuthBtn"),
    selectedCount: document.getElementById("selectedCount"),
    // Export (Inspect tab)
    exportCard: document.getElementById("exportCard"),
    exportBtnRow: document.getElementById("exportBtnRow"),
    exportSnippetBox: document.getElementById("exportSnippetBox"),
    exportSnippetPre: document.getElementById("exportSnippetPre"),
    exportCopyBtn: document.getElementById("exportCopyBtn"),
    // Job
    jobUrl: document.getElementById("jobUrl"),
    jobPreview: document.getElementById("jobPreview"),
    submitJobBtn: document.getElementById("submitJobBtn"),
    copyJobBtn: document.getElementById("copyJobBtn"),
    jobStatus: document.getElementById("jobStatus"),
    // Job export
    jobExportCard: document.getElementById("jobExportCard"),
    jobExportBtnRow: document.getElementById("jobExportBtnRow"),
    jobExportSnippetBox: document.getElementById("jobExportSnippetBox"),
    jobExportSnippetPre: document.getElementById("jobExportSnippetPre"),
    jobExportCopyBtn: document.getElementById("jobExportCopyBtn"),
    // Account
    accountAuthCheck: document.getElementById("accountAuthCheck"),
    accountLogin: document.getElementById("accountLogin"),
    accountLoginBtn: document.getElementById("accountLoginBtn"),
    accountSignupLink: document.getElementById("accountSignupLink"),
    accountUseApiKeyBtn: document.getElementById("accountUseApiKeyBtn"),
    accountHideApiKeyBtn: document.getElementById("accountHideApiKeyBtn"),
    accountApiKeyPanel: document.getElementById("accountApiKeyPanel"),
    accountSetup: document.getElementById("accountSetup"),
    accountConnected: document.getElementById("accountConnected"),
    apiKeyInput: document.getElementById("apiKeyInput"),
    apiUrlInput: document.getElementById("apiUrlInput"),
    connectBtn: document.getElementById("connectBtn"),
    accountStatus: document.getElementById("accountStatus"),
    accountInstance: document.getElementById("accountInstance"),
    accountCredits: document.getElementById("accountCredits"),
    creditsBarFill: document.getElementById("creditsBarFill"),
    accountSessions: document.getElementById("accountSessions"),
    disconnectBtn: document.getElementById("disconnectBtn"),
    savedSessionsCard: document.getElementById("savedSessionsCard"),
    sessionCountBadge: document.getElementById("sessionCountBadge"),
    savedSessionsList: document.getElementById("savedSessionsList"),
    // Robots
    rtFetchBtn: document.getElementById("rtFetchBtn"),
    rtLoading: document.getElementById("rtLoading"),
    rtStatus: document.getElementById("rtStatus"),
    rtUpsell: document.getElementById("rtUpsell"),
    rtContent: document.getElementById("rtContent"),
    rtCodeBlock: document.getElementById("rtCodeBlock"),
    rtBotList: document.getElementById("rtBotList"),
    rtBotRules: document.getElementById("rtBotRules"),
    rtCrawlInput: document.getElementById("rtCrawlInput"),
    rtCheckBtn: document.getElementById("rtCheckBtn"),
    rtCrawlResult: document.getElementById("rtCrawlResult"),
    rtSitemapContainer: document.getElementById("rtSitemapContainer"),
    rtSitemapTree: document.getElementById("rtSitemapTree"),
    rtExportUrls: document.getElementById("rtExportUrls"),
    rtCopyRobots: document.getElementById("rtCopyRobots"),
    // Onboarding carousel
    onboardingOverlay: document.getElementById("onboardingOverlay"),
    onboardingScoreNum: document.getElementById("onboardingScoreNum"),
    onboardingBackBtn: document.getElementById("onboardingBackBtn"),
    onboardingNextBtn: document.getElementById("onboardingNextBtn"),
    onboardingDots: document.getElementById("onboardingDots"),
    // Selector builder
    selToggleBtn: document.getElementById("selToggleBtn"),
    selActiveIndicator: document.getElementById("selActiveIndicator"),
    selCountBadge: document.getElementById("selCountBadge"),
    selSelectorList: document.getElementById("selSelectorList"),
    selExportCard: document.getElementById("selExportCard"),
    selCopyCurl: document.getElementById("selCopyCurl"),
    selCopyPython: document.getElementById("selCopyPython"),
    selCopyNode: document.getElementById("selCopyNode"),
    selCopyJson: document.getElementById("selCopyJson"),
    selClearAll: document.getElementById("selClearAll"),
    selStatus: document.getElementById("selStatus"),
    // Meta Tab (SEO Analyzer)
    seoScoreRing: document.getElementById("seoScoreRing"),
    seoScoreValue: document.getElementById("seoScoreValue"),
    seoScoreLabel: document.getElementById("seoScoreLabel"),
    seoScoreDesc: document.getElementById("seoScoreDesc"),
    seoIssuesCard: document.getElementById("seoIssuesCard"),
    seoIssueCount: document.getElementById("seoIssueCount"),
    seoIssueList: document.getElementById("seoIssueList"),
    seoBasicTable: document.getElementById("seoBasicTable"),
    ogTagCount: document.getElementById("ogTagCount"),
    ogImagePreview: document.getElementById("ogImagePreview"),
    ogImageEl: document.getElementById("ogImageEl"),
    ogTable: document.getElementById("ogTable"),
    twitterTagCount: document.getElementById("twitterTagCount"),
    twitterTable: document.getElementById("twitterTable"),
    jsonLdCount: document.getElementById("jsonLdCount"),
    jsonLdContent: document.getElementById("jsonLdContent"),
    metaCopyAllBtn: document.getElementById("metaCopyAllBtn"),
    // Share Report
    shareReportBtn: document.getElementById("shareReportBtn"),
    shareReportResult: document.getElementById("shareReportResult"),
    shareReportUrl: document.getElementById("shareReportUrl"),
    shareReportCopyBtn: document.getElementById("shareReportCopyBtn"),
    shareReportStatus: document.getElementById("shareReportStatus"),
    // Offline banner
    offlineBanner: document.getElementById("offlineBanner"),
    // Inline auth prompts
    captureAuthPrompt: document.getElementById("captureAuthPrompt"),
    captureAuthKey: document.getElementById("captureAuthKey"),
    captureAuthConnect: document.getElementById("captureAuthConnect"),
    captureAuthStatus: document.getElementById("captureAuthStatus"),
    jobAuthPrompt: document.getElementById("jobAuthPrompt"),
    jobAuthKey: document.getElementById("jobAuthKey"),
    jobAuthConnect: document.getElementById("jobAuthConnect"),
    jobAuthStatus: document.getElementById("jobAuthStatus"),
    // Scrape
    scrapeFormatGrid: document.getElementById("scrapeFormatGrid"),
    scrapeRunBtn: document.getElementById("scrapeRunBtn"),
    scrapeStatus: document.getElementById("scrapeStatus"),
    scrapeResultsCard: document.getElementById("scrapeResultsCard"),
    scrapeResultsContent: document.getElementById("scrapeResultsContent"),
    scrapeCopyBtn: document.getElementById("scrapeCopyBtn"),
    scrapeDownloadBtn: document.getElementById("scrapeDownloadBtn"),
    scrapeUsagePill: document.getElementById("scrapeUsagePill"),
    scrapeUpsell: document.getElementById("scrapeUpsell"),
    upsellConnectLink: document.getElementById("upsellConnectLink"),
  };
}

// ---------------------------------------------------------------------------
// Tab Navigation
// ---------------------------------------------------------------------------

let hdrRefreshInterval = null;

function bindTabNavigation() {
  const buttons = document.querySelectorAll(".tab-bar button");
  const indicator = document.getElementById("tabBarIndicator");
  const tabBar = document.querySelector(".tab-bar");

  // Position indicator on initial active tab
  requestAnimationFrame(() => {
    updateTabIndicator(buttons[currentTabIndex], indicator);
    updateTabBarScrollState(tabBar);
  });

  // Track scroll position to toggle gradient fade
  tabBar.addEventListener("scroll", () => updateTabBarScrollState(tabBar), { passive: true });

  buttons.forEach((btn, index) => {
    btn.addEventListener("click", () => {
      if (index === currentTabIndex) return;

      const tabName = btn.dataset.tab;
      const direction = index > currentTabIndex ? "slide-left" : "slide-right";
      const prevIndex = currentTabIndex;
      currentTabIndex = index;

      // Update button states
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      // Scroll the active tab into view
      btn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });

      // Slide the underline indicator
      updateTabIndicator(btn, indicator);

      // Update panels with slide direction
      document.querySelectorAll(".tab-panel").forEach((p) => {
        p.classList.remove("active", "slide-left", "slide-right");
      });
      const panel = document.getElementById(`panel-${tabName}`);
      panel.classList.add("active", direction);

      // Render Meta tab when switching to it
      if (tabName === "meta") {
        renderMetaTab();
      }

      // Auto-refresh headers when network tab is active (headers merged into network)
      if (tabName === "network") {
        loadNetworkRequests();
        hdrRefreshInterval = setInterval(loadNetworkRequests, 2000);
      } else if (hdrRefreshInterval) {
        clearInterval(hdrRefreshInterval);
        hdrRefreshInterval = null;
      }

      // Deactivate selector builder when switching away
      if (tabName !== "selector" && selActive) {
        deactivateSelectorBuilder();
      }
    });
  });
}

/**
 * Toggle the scrolled-end class on the tab bar based on scroll position.
 * Hides the right-edge gradient fade when scrolled to the end.
 */
function updateTabBarScrollState(tabBar) {
  const atEnd = tabBar.scrollLeft + tabBar.clientWidth >= tabBar.scrollWidth - 2;
  tabBar.classList.toggle("scrolled-end", atEnd);
}

function updateTabIndicator(btn, indicator) {
  if (!btn || !indicator) return;
  const rect = btn.getBoundingClientRect();
  const barRect = btn.parentElement.getBoundingClientRect();
  const scrollLeft = btn.parentElement.scrollLeft;
  indicator.style.left = (rect.left - barRect.left + scrollLeft) + "px";
  indicator.style.width = rect.width + "px";
}

/**
 * Programmatically switch to a tab by name.
 * Simulates a click on the tab button — reuses existing navigation logic.
 */
function switchToTab(tabName) {
  const btn = document.querySelector(`.tab-bar button[data-tab="${tabName}"]`);
  if (btn) btn.click();
}

// ---------------------------------------------------------------------------
// Inspect Tab — Page Analysis
// ---------------------------------------------------------------------------

async function requestPageAnalysis(tabId) {
  // Set badge to "..." while analyzing
  browser.runtime.sendMessage({ type: "BADGE_LOADING" });

  try {
    // Race the content script message against a 3s timeout
    const analysis = await Promise.race([
      browser.tabs.sendMessage(tabId, { type: "ANALYZE_PAGE" }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("TIMEOUT")), 3000),
      ),
    ]);

    if (analysis && !analysis.error) {
      analysisResolved = true;
      currentAnalysis = analysis;
      renderInspectTab(analysis);
      renderMetaTab();
      updateJobPreview(analysis);
      // Send score to background for badge
      browser.runtime.sendMessage({
        type: "SCRAPE_SCORE",
        score: analysis.score,
        domain: currentDomain,
      });
    } else {
      analysisResolved = true;
      browser.runtime.sendMessage({ type: "BADGE_ERROR" });
      renderInspectError(analysis?.error || "Content script not available");
      showToast(
        "warning",
        "Analysis unavailable",
        analysis?.error || "Content script not available on this page.",
      );
    }
  } catch (err) {
    analysisResolved = true;
    browser.runtime.sendMessage({ type: "BADGE_ERROR" });
    if (err.message === "TIMEOUT") {
      renderInspectTimeout();
      showToast(
        "warning",
        "Analysis timed out",
        "Try refreshing the page.",
        {
          actionLabel: "Retry",
          onAction: () => requestPageAnalysis(tabId),
        },
      );
    } else {
      renderInspectError(
        "Cannot analyze this page. Try refreshing or navigate to a web page.",
      );
      showToast(
        "error",
        "Page analysis failed",
        "Navigate to a web page and try again.",
      );
    }
  }
}

function renderInspectTab(analysis) {
  // ---------- Score circle — reveal with animation ----------
  const score = analysis.score;
  const circumference = 2 * Math.PI * 28; // r=28
  const offset = circumference - (score / 100) * circumference;
  const color = scrapeScoreColor(score);

  // Hide skeleton, show score with scale-in animation
  if (els.scoreSkeleton) {
    els.scoreSkeleton.style.display = "none";
  }

  els.scoreRing.style.stroke = color;
  els.scoreRing.style.strokeDashoffset = String(offset);
  els.scoreRing.classList.add("ring-revealed");

  els.scoreValue.style.opacity = "1";
  els.scoreValue.textContent = String(score);
  els.scoreValue.style.color = color;
  els.scoreValue.classList.add("score-revealed");

  // Pulse the score value if it changed from a previous analysis
  if (previousScore !== null && previousScore !== score) {
    els.scoreValue.classList.remove("pulse");
    // Force reflow so the animation restarts
    void els.scoreValue.offsetWidth;
    els.scoreValue.classList.add("pulse");
  }
  previousScore = score;

  // Use shared utility for difficulty label
  els.scoreDifficulty.textContent = scrapeScoreLabel(score);
  els.scoreDifficulty.classList.remove("analyzing-pulse");

  // Update overlay score preview (visible during first-run)
  updateOnboardingScore(score);

  // Clear skeleton text and show description
  if (score <= 20) {
    els.scoreDescription.textContent =
      "Standard HTML page. Basic HTTP request should work.";
  } else if (score <= 40) {
    els.scoreDescription.textContent =
      "Minor complexity detected. May need headers or cookies.";
  } else if (score <= 60) {
    els.scoreDescription.textContent =
      "JS rendering or anti-bot detected. Browser tier recommended.";
  } else if (score <= 80) {
    els.scoreDescription.textContent =
      "Significant protection. Stealth browser or session cookies needed.";
  } else {
    els.scoreDescription.textContent =
      "Heavy anti-bot protection. Authenticated session likely required.";
  }

  // Conversion hook — show when score > 60
  renderConversionHook(analysis);

  // ---------- Anti-bot stack (categorized) — progressive reveal (150ms after score) ----------
  setTimeout(() => {
    renderAntiBotStack(analysis);
    els.antiBotCard.classList.add("card-revealed");
  }, 150);

  // ---------- Signals — progressive reveal (300ms after score) ----------
  setTimeout(() => {
    els.signalList.innerHTML = "";
    if (analysis.signals && analysis.signals.length > 0) {
      els.signalCount.textContent = String(analysis.signals.length);
      for (const signal of analysis.signals) {
        const li = document.createElement("li");
        const dot = document.createElement("span");
        dot.className = "signal-dot";
        // Color based on signal severity
        if (
          signal.toLowerCase().includes("anti-bot") ||
          signal.toLowerCase().includes("login") ||
          signal.toLowerCase().includes("captcha")
        ) {
          dot.classList.add("red");
        } else if (
          signal.toLowerCase().includes("client-side") ||
          signal.toLowerCase().includes("shadow") ||
          signal.toLowerCase().includes("iframe")
        ) {
          dot.classList.add("yellow");
        } else {
          dot.classList.add("green");
        }
        li.appendChild(dot);
        li.appendChild(document.createTextNode(signal));
        els.signalList.appendChild(li);
      }
    } else {
      els.signalCount.textContent = "0";
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "signal-dot green";
      li.appendChild(dot);
      li.appendChild(
        document.createTextNode("No complexity signals detected"),
      );
      els.signalList.appendChild(li);
    }
    els.signalsCard.classList.add("card-revealed");
  }, 300);

  // Pagination
  if (analysis.pagination) {
    els.paginationCard.style.display = "block";
    els.paginationInfo.innerHTML = "";
    const typeSpan = document.createElement("span");
    typeSpan.className = "pagination-type";
    typeSpan.textContent = analysis.pagination.type;
    els.paginationInfo.appendChild(typeSpan);
    if (analysis.pagination.pages) {
      const pagesSpan = document.createElement("span");
      pagesSpan.textContent = `~${analysis.pagination.pages} pages`;
      pagesSpan.style.color = "var(--text-muted)";
      els.paginationInfo.appendChild(pagesSpan);
    }
  }

  // API endpoints
  els.apiCard.style.display = "block";
  if (analysis.apiEndpoints && analysis.apiEndpoints.length > 0) {
    els.apiCount.textContent = String(analysis.apiEndpoints.length);
    els.apiEndpointList.innerHTML = "";
    for (const endpoint of analysis.apiEndpoints) {
      const li = document.createElement("li");
      li.textContent = endpoint;
      li.title = endpoint;
      els.apiEndpointList.appendChild(li);
    }
  } else {
    els.apiCount.textContent = "0";
    renderEmptyState(els.apiEndpointList, {
      icon: EMPTY_ICONS.api,
      title: "No data endpoints detected",
      description: "This page uses server-side rendering or no detectable API calls.",
    });
  }

  // Tech Stack
  renderTechStack(analysis.techStack);
}

/**
 * Render the detected tech stack as categorized pills in the Inspect tab.
 */
function renderTechStack(techStack) {
  if (!techStack) {
    els.techStackCard.style.display = "none";
    return;
  }

  const categories = [
    {
      key: "frameworks",
      label: "Frameworks",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    },
    {
      key: "cdns",
      label: "CDNs",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    },
    {
      key: "antiBot",
      label: "Anti-Bot",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    },
    {
      key: "analytics",
      label: "Analytics",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    },
    {
      key: "hosting",
      label: "Hosting",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
    },
  ];

  // Count total detected technologies
  let totalCount = 0;
  for (const cat of categories) {
    totalCount += (techStack[cat.key] || []).length;
  }

  if (totalCount === 0) {
    els.techStackCard.style.display = "none";
    return;
  }

  els.techStackCard.style.display = "block";
  els.techStackCount.textContent = String(totalCount);
  els.techStackBody.innerHTML = "";

  for (const cat of categories) {
    const items = techStack[cat.key] || [];
    if (items.length === 0) continue;

    const section = document.createElement("div");
    section.className = "tech-stack-category";

    const header = document.createElement("div");
    header.className = "tech-stack-category-header";
    header.innerHTML = cat.icon;
    const headerText = document.createElement("span");
    headerText.textContent = cat.label;
    header.appendChild(headerText);
    section.appendChild(header);

    const pillsContainer = document.createElement("div");
    pillsContainer.className = "tech-stack-pills";

    for (const tech of items) {
      const pill = document.createElement("span");
      pill.className = `tech-pill cat-${cat.key}`;
      pill.textContent = tech;
      pillsContainer.appendChild(pill);
    }

    section.appendChild(pillsContainer);
    els.techStackBody.appendChild(section);
  }

  // Send tech count to background for badge update
  browser.runtime.sendMessage({
    type: "TECH_STACK_COUNT",
    count: totalCount,
    domain: currentDomain,
  });
}

function renderInspectError(message) {
  // Remove skeleton state
  if (els.scoreSkeleton) {
    els.scoreSkeleton.style.display = "none";
  }
  els.scoreValue.style.opacity = "1";
  els.scoreValue.textContent = "--";
  els.scoreDifficulty.textContent = "Unavailable";
  els.scoreDifficulty.classList.remove("analyzing-pulse");
  els.scoreDescription.textContent = message;
  els.antiBotStack.innerHTML =
    '<div class="antibot-stack-empty">N/A</div>';
  els.antiBotCount.textContent = "0";
  els.signalList.innerHTML = `<li><span class="signal-dot yellow"></span>${message}</li>`;
  // Hide conversion hook and tech stack on error
  els.conversionHook.classList.remove("visible");
  els.techStackCard.style.display = "none";
}

function renderInspectTimeout() {
  // Remove skeleton and pulse state (matches renderInspectError cleanup)
  if (els.scoreSkeleton) {
    els.scoreSkeleton.style.display = "none";
  }
  els.scoreValue.style.opacity = "1";
  els.scoreValue.textContent = "?";
  els.scoreDifficulty.textContent = "Timed out";
  els.scoreDifficulty.classList.remove("analyzing-pulse");
  els.scoreDescription.textContent =
    "Analysis timed out \u2014 try refreshing the page.";
  els.antiBotStack.innerHTML =
    '<span class="antibot-tag none">Unknown</span>';
  els.signalList.innerHTML =
    '<li><span class="signal-dot yellow"></span>Analysis timed out \u2014 try refreshing</li>';
  els.conversionHook.classList.remove("visible");
}

// ---------------------------------------------------------------------------
// Meta Tab — SEO Analyzer
// ---------------------------------------------------------------------------

/**
 * Render the Meta tab using currentAnalysis.meta data collected by content.js.
 * Populates SEO score ring, issues list, SEO tags table, OG table, Twitter
 * cards table, and JSON-LD structured data blocks.
 * Safe to call when currentAnalysis is null — shows "Not available" state.
 */
function renderMetaTab() {
  const meta = currentAnalysis && currentAnalysis.meta ? currentAnalysis.meta : null;
  const circumference = 2 * Math.PI * 28; // r=28, matches Inspect tab ring

  if (!meta) {
    // No analysis yet — show clear unavailable state rather than "Scanning..."
    if (els.seoScoreValue) els.seoScoreValue.textContent = "--";
    if (els.seoScoreLabel) els.seoScoreLabel.textContent = "Not available";
    if (els.seoScoreDesc) els.seoScoreDesc.textContent = "Analyze a page first.";
    if (els.seoIssuesCard) els.seoIssuesCard.style.display = "none";
    if (els.seoBasicTable) els.seoBasicTable.innerHTML = '<div class="meta-row placeholder"><span class="meta-key">No data</span></div>';
    if (els.ogTable) els.ogTable.innerHTML = '<div class="meta-row placeholder"><span class="meta-key">No data</span></div>';
    if (els.twitterTable) els.twitterTable.innerHTML = '<div class="meta-row placeholder"><span class="meta-key">No data</span></div>';
    if (els.jsonLdContent) els.jsonLdContent.innerHTML = '<div class="meta-row placeholder"><span class="meta-key">No data</span></div>';
    return;
  }

  // ------------------------------------------------------------------
  // 1. Compute SEO score and issues
  // ------------------------------------------------------------------
  const issues = [];
  const title = meta.title || "";
  const description = (meta.basic && meta.basic["description"]) || meta["description"] || "";
  const canonical = meta.canonical || "";
  const robots = (meta.basic && meta.basic["robots"]) || meta["robots"] || "";
  const ogKeys = meta.og || {};
  const twitterKeys = meta.twitter || {};
  const jsonLd = Array.isArray(meta.jsonLd) ? meta.jsonLd : [];

  // Title checks
  if (!title) {
    issues.push({ severity: "error", text: "Missing <title> tag" });
  } else if (title.length < 10) {
    issues.push({ severity: "warning", text: `Title too short (${title.length} chars, aim for 30–60)` });
  } else if (title.length > 60) {
    issues.push({ severity: "warning", text: `Title too long (${title.length} chars, aim for 30–60)` });
  }

  // Description checks
  if (!description) {
    issues.push({ severity: "error", text: "Missing meta description" });
  } else if (description.length < 50) {
    issues.push({ severity: "warning", text: `Meta description too short (${description.length} chars, aim for 120–160)` });
  } else if (description.length > 160) {
    issues.push({ severity: "warning", text: `Meta description too long (${description.length} chars, aim for 120–160)` });
  }

  // Canonical check
  if (!canonical) {
    issues.push({ severity: "warning", text: "No canonical URL defined" });
  }

  // Robots noindex/nofollow check
  if (robots && (robots.includes("noindex") || robots.includes("nofollow"))) {
    issues.push({ severity: "error", text: `Robots directive blocks crawling: "${robots}"` });
  }

  // OG checks
  if (!ogKeys["og:title"]) {
    issues.push({ severity: "warning", text: "Missing og:title — needed for social sharing" });
  }
  if (!ogKeys["og:description"]) {
    issues.push({ severity: "warning", text: "Missing og:description — needed for social sharing" });
  }
  if (!ogKeys["og:image"]) {
    issues.push({ severity: "warning", text: "Missing og:image — social previews will be blank" });
  }

  // Twitter card check
  if (!twitterKeys["twitter:card"]) {
    issues.push({ severity: "info", text: "No Twitter Card tags found" });
  }

  // Score calculation: start at 100, deduct per issue
  let seoScore = 100;
  for (const issue of issues) {
    if (issue.severity === "error") seoScore -= 20;
    else if (issue.severity === "warning") seoScore -= 8;
    else if (issue.severity === "info") seoScore -= 3;
  }
  seoScore = Math.max(0, Math.min(100, seoScore));

  // ------------------------------------------------------------------
  // 2. Render score ring
  // ------------------------------------------------------------------
  const offset = circumference - (seoScore / 100) * circumference;
  let ringColor;
  if (seoScore >= 80) ringColor = "var(--success, #22c55e)";
  else if (seoScore >= 50) ringColor = "var(--warning, #f59e0b)";
  else ringColor = "var(--error, #ef4444)";

  if (els.seoScoreRing) {
    els.seoScoreRing.style.stroke = ringColor;
    els.seoScoreRing.style.strokeDashoffset = String(offset);
    els.seoScoreRing.classList.add("ring-revealed");
  }
  if (els.seoScoreValue) {
    els.seoScoreValue.textContent = String(seoScore);
    els.seoScoreValue.style.color = ringColor;
    els.seoScoreValue.style.opacity = "1";
    els.seoScoreValue.classList.add("score-revealed");
  }

  let scoreLabel, scoreDesc;
  if (seoScore >= 90) { scoreLabel = "Excellent"; scoreDesc = "Strong SEO metadata — well optimized."; }
  else if (seoScore >= 70) { scoreLabel = "Good"; scoreDesc = "A few improvements could help visibility."; }
  else if (seoScore >= 50) { scoreLabel = "Needs work"; scoreDesc = "Several SEO issues detected."; }
  else { scoreLabel = "Poor"; scoreDesc = "Critical SEO metadata is missing."; }

  if (els.seoScoreLabel) els.seoScoreLabel.textContent = scoreLabel;
  if (els.seoScoreDesc) els.seoScoreDesc.textContent = scoreDesc;

  // ------------------------------------------------------------------
  // 3. Render issues list
  // ------------------------------------------------------------------
  if (els.seoIssuesCard && els.seoIssueList && els.seoIssueCount) {
    if (issues.length > 0) {
      els.seoIssuesCard.style.display = "block";
      els.seoIssueCount.textContent = String(issues.length);
      els.seoIssueList.innerHTML = "";
      for (const issue of issues) {
        const li = document.createElement("li");
        li.className = "seo-issue-item";
        const dotColor =
          issue.severity === "error" ? "var(--error, #ef4444)"
          : issue.severity === "warning" ? "var(--warning, #f59e0b)"
          : "var(--text-muted)";
        li.innerHTML = `<span class="signal-dot" style="background:${dotColor};flex-shrink:0;"></span><span>${escapeHtml(issue.text)}</span>`;
        els.seoIssueList.appendChild(li);
      }
    } else {
      els.seoIssuesCard.style.display = "none";
    }
  }

  // ------------------------------------------------------------------
  // 4. Render Basic SEO Tags table
  // ------------------------------------------------------------------
  if (els.seoBasicTable) {
    const basicRows = [
      { key: "title", label: "Title", value: title },
      { key: "description", label: "Description", value: description },
      { key: "canonical", label: "Canonical", value: canonical },
      { key: "robots", label: "Robots", value: (meta.basic && meta.basic["robots"]) || meta["robots"] || "" },
      { key: "author", label: "Author", value: (meta.basic && meta.basic["author"]) || "" },
      { key: "keywords", label: "Keywords", value: (meta.basic && meta.basic["keywords"]) || "" },
      { key: "viewport", label: "Viewport", value: (meta.basic && meta.basic["viewport"]) || "" },
    ];

    els.seoBasicTable.innerHTML = "";
    let anyBasic = false;
    for (const row of basicRows) {
      if (!row.value) continue;
      anyBasic = true;
      els.seoBasicTable.appendChild(buildMetaRow(row.label, row.value));
    }
    if (!anyBasic) {
      els.seoBasicTable.innerHTML = '<div class="meta-row placeholder"><span class="meta-key">None found</span></div>';
    }
  }

  // ------------------------------------------------------------------
  // 5. Render Open Graph table
  // ------------------------------------------------------------------
  if (els.ogTable) {
    const ogEntries = Object.entries(ogKeys);
    els.ogTable.innerHTML = "";
    if (els.ogTagCount) els.ogTagCount.textContent = String(ogEntries.length);

    if (ogEntries.length === 0) {
      els.ogTable.innerHTML = '<div class="meta-row placeholder"><span class="meta-key">No OG tags found</span></div>';
    } else {
      for (const [key, value] of ogEntries) {
        els.ogTable.appendChild(buildMetaRow(key, value));
      }
    }

    // OG image preview
    const ogImage = ogKeys["og:image"];
    if (els.ogImagePreview && els.ogImageEl) {
      if (ogImage) {
        els.ogImageEl.src = ogImage;
        els.ogImageEl.onerror = () => { els.ogImagePreview.style.display = "none"; };
        els.ogImageEl.onload = () => { els.ogImagePreview.style.display = "block"; };
        els.ogImagePreview.style.display = "none"; // shown by onload
      } else {
        els.ogImagePreview.style.display = "none";
      }
    }
  }

  // ------------------------------------------------------------------
  // 6. Render Twitter Cards table
  // ------------------------------------------------------------------
  if (els.twitterTable) {
    const twitterEntries = Object.entries(twitterKeys);
    els.twitterTable.innerHTML = "";
    if (els.twitterTagCount) els.twitterTagCount.textContent = String(twitterEntries.length);

    if (twitterEntries.length === 0) {
      els.twitterTable.innerHTML = '<div class="meta-row placeholder"><span class="meta-key">No Twitter Card tags found</span></div>';
    } else {
      for (const [key, value] of twitterEntries) {
        els.twitterTable.appendChild(buildMetaRow(key, value));
      }
    }
  }

  // ------------------------------------------------------------------
  // 7. Render JSON-LD blocks
  // ------------------------------------------------------------------
  if (els.jsonLdContent) {
    els.jsonLdContent.innerHTML = "";
    if (els.jsonLdCount) els.jsonLdCount.textContent = String(jsonLd.length);

    if (jsonLd.length === 0) {
      els.jsonLdContent.innerHTML = '<div class="meta-row placeholder"><span class="meta-key">No JSON-LD found</span></div>';
    } else {
      for (let i = 0; i < jsonLd.length; i++) {
        const schema = jsonLd[i];
        const schemaType = schema["@type"] || "Unknown";
        const wrapper = document.createElement("div");
        wrapper.className = "json-ld-block";
        wrapper.style.cssText = "margin-bottom:8px;";

        const label = document.createElement("div");
        label.className = "json-ld-type-label";
        label.style.cssText = "font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;";
        label.textContent = Array.isArray(schemaType) ? schemaType.join(", ") : String(schemaType);
        wrapper.appendChild(label);

        const pre = document.createElement("pre");
        pre.className = "json-ld-pre";
        pre.style.cssText = "margin:0;padding:10px;background:var(--bg-input);border-radius:6px;font-size:11px;line-height:1.5;overflow-x:auto;white-space:pre-wrap;word-break:break-word;color:var(--text-primary);";
        pre.textContent = JSON.stringify(schema, null, 2);
        wrapper.appendChild(pre);
        els.jsonLdContent.appendChild(wrapper);
      }
    }
  }

  // ------------------------------------------------------------------
  // 8. Wire "Copy All as JSON" button (idempotent — remove old listener first)
  // ------------------------------------------------------------------
  if (els.metaCopyAllBtn) {
    const newBtn = els.metaCopyAllBtn.cloneNode(true);
    els.metaCopyAllBtn.parentNode.replaceChild(newBtn, els.metaCopyAllBtn);
    els.metaCopyAllBtn = newBtn;

    els.metaCopyAllBtn.addEventListener("click", () => {
      const exportData = {
        url: currentUrl,
        title,
        canonical,
        basic: meta.basic || {},
        og: meta.og || {},
        twitter: meta.twitter || {},
        jsonLd: meta.jsonLd || [],
        seoScore,
        seoIssues: issues,
      };
      const text = JSON.stringify(exportData, null, 2);
      navigator.clipboard.writeText(text).then(() => {
        const orig = els.metaCopyAllBtn.textContent;
        els.metaCopyAllBtn.textContent = "Copied!";
        setTimeout(() => { els.metaCopyAllBtn.textContent = orig; }, 1500);
      }).catch(() => {
        showToast("error", "Copy failed", "Could not copy to clipboard.");
      });
    });
  }
}

/**
 * Build a single meta-table row element with key and value.
 * Truncates long values and shows full value on title hover.
 */
function buildMetaRow(key, value) {
  const row = document.createElement("div");
  row.className = "meta-row";

  const keyEl = document.createElement("span");
  keyEl.className = "meta-key";
  keyEl.textContent = key;

  const valEl = document.createElement("span");
  valEl.className = "meta-value";
  const strVal = String(value);
  valEl.textContent = strVal.length > 120 ? strVal.substring(0, 120) + "…" : strVal;
  valEl.title = strVal;

  row.appendChild(keyEl);
  row.appendChild(valEl);
  return row;
}

/**
 * Category metadata for rendering grouped anti-bot badges.
 */
const ANTIBOT_CATEGORIES = {
  "bot-management": {
    label: "Bot Management",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="m2 14 2-2-2-2"/><path d="m22 14-2-2 2-2"/><path d="M10 16v.01"/><path d="M14 16v.01"/></svg>',
    order: 1,
  },
  captcha: {
    label: "CAPTCHAs",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/></svg>',
    order: 2,
  },
  fingerprinting: {
    label: "Fingerprinting",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>',
    order: 3,
  },
  waf: {
    label: "WAF / CDN",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>',
    order: 4,
  },
  "js-challenge": {
    label: "JS Challenges",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    order: 5,
  },
};

/**
 * Render the categorized anti-bot stack with colored badges and tooltips.
 */
function renderAntiBotStack(analysis) {
  els.antiBotStack.innerHTML = "";

  const stack = analysis.antiBotStack || [];

  if (stack.length === 0) {
    // Fall back to flat antiBot list for backward compat
    if (analysis.antiBot && analysis.antiBot.length > 0) {
      // Legacy format — show as flat badges without categories
      const container = document.createElement("div");
      container.className = "antibot-category-items";
      for (const name of analysis.antiBot) {
        const badge = document.createElement("span");
        badge.className = "antibot-badge cat-bot-management";
        badge.textContent = name;
        container.appendChild(badge);
      }
      els.antiBotStack.appendChild(container);
      els.antiBotCount.textContent = String(analysis.antiBot.length);
    } else {
      els.antiBotStack.innerHTML =
        '<div class="antibot-stack-empty"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> No protection detected</div>';
      els.antiBotCount.textContent = "0";
    }
    return;
  }

  els.antiBotCount.textContent = String(stack.length);

  // Group by category
  const groups = {};
  for (const item of stack) {
    const cat = item.category || "bot-management";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(item);
  }

  // Sort categories by display order
  const sortedCats = Object.keys(groups).sort((a, b) => {
    const orderA = (ANTIBOT_CATEGORIES[a] || {}).order || 99;
    const orderB = (ANTIBOT_CATEGORIES[b] || {}).order || 99;
    return orderA - orderB;
  });

  for (const cat of sortedCats) {
    const catMeta = ANTIBOT_CATEGORIES[cat] || {
      label: cat,
      icon: "",
      order: 99,
    };
    const items = groups[cat];

    const section = document.createElement("div");
    section.className = "antibot-category";

    // Category header
    const label = document.createElement("div");
    label.className = "antibot-category-label";
    label.innerHTML = catMeta.icon;
    label.appendChild(document.createTextNode(catMeta.label));
    section.appendChild(label);

    // Badges
    const badgeContainer = document.createElement("div");
    badgeContainer.className = "antibot-category-items";

    for (const item of items) {
      const badge = document.createElement("span");
      badge.className = `antibot-badge cat-${cat}`;

      // Name text
      const nameSpan = document.createTextNode(item.name);
      badge.appendChild(nameSpan);

      // Tier pip
      const tierPip = document.createElement("span");
      tierPip.className = "tier-pip";
      tierPip.textContent = `T${item.tier}`;
      badge.appendChild(tierPip);

      // Tooltip
      const tooltip = document.createElement("div");
      tooltip.className = "antibot-tooltip";
      tooltip.innerHTML =
        `Requires <span class="tooltip-technique">${item.technique}</span><br>` +
        `Supported by <span class="tooltip-tier">AlterLab Tier ${item.tier}</span>`;
      badge.appendChild(tooltip);

      badgeContainer.appendChild(badge);
    }

    section.appendChild(badgeContainer);
    els.antiBotStack.appendChild(section);
  }
}

/**
 * Render the conversion hook CTA when the score indicates significant protection.
 * Shows detected anti-bot stack and the AlterLab tier that bypasses it.
 */
function renderConversionHook(analysis) {
  const score = analysis.score;

  if (score <= 60) {
    els.conversionHook.classList.remove("visible");
    return;
  }

  els.conversionHook.classList.add("visible");

  // Use structured stack data for richer conversion messaging
  const structured = analysis.antiBotStack || [];
  const flat = analysis.antiBot || [];

  if (structured.length > 0) {
    // Find the highest tier needed across all detections
    const maxTier = Math.max(...structured.map((s) => s.tier));
    const names = structured.map((s) => s.name);

    els.hookTitle.textContent = "AlterLab bypasses this automatically";
    els.hookBody.textContent = `This site uses ${names.join(", ")}.`;
    els.hookStack.textContent = `${structured.length} protection layer${structured.length > 1 ? "s" : ""} detected`;
    els.hookTierBadge.textContent = `Tier ${maxTier}`;
    els.hookTierBadge.className = `tier-badge tier-${maxTier}`;
  } else if (flat.length > 0) {
    const tier = scrapeScoreTier(score);
    els.hookTitle.textContent = "AlterLab bypasses this automatically";
    els.hookBody.textContent = `This site uses ${flat.join(", ")}.`;
    els.hookStack.textContent = `Detected: ${flat.join(", ")}`;
    els.hookTierBadge.textContent = `Tier ${tier}`;
    els.hookTierBadge.className = `tier-badge tier-${tier}`;
  } else {
    const tier = scrapeScoreTier(score);
    els.hookBody.textContent =
      "This site has significant scrape complexity.";
    els.hookTitle.textContent = "AlterLab handles this";
    els.hookStack.textContent = "";
    els.hookTierBadge.textContent = `Tier ${tier}`;
    els.hookTierBadge.className = `tier-badge tier-${tier}`;
  }
}

// ---------------------------------------------------------------------------
// Capture Tab — Cookie Management
// ---------------------------------------------------------------------------

function bindCaptureEvents() {
  els.captureBtn.addEventListener("click", handleCapture);
  els.openDashboardBtn.addEventListener("click", handleOpenDashboard);
  els.copyBtn.addEventListener("click", handleCopyJson);
  els.selectAllBtn.addEventListener("click", () => {
    selectedCookieKeys = new Set(currentCookies.map(cookieKey));
    syncCheckboxes();
    updateSelectedCount();
  });
  els.selectNoneBtn.addEventListener("click", () => {
    selectedCookieKeys = new Set();
    syncCheckboxes();
    updateSelectedCount();
  });
  els.selectAuthBtn.addEventListener("click", () => {
    selectedCookieKeys = new Set();
    for (const cookie of currentCookies) {
      if (isAuthCookie(cookie.name)) {
        selectedCookieKeys.add(cookieKey(cookie));
      }
    }
    syncCheckboxes();
    updateSelectedCount();
  });
}

async function loadCookies() {
  if (!currentDomain) return;

  try {
    const baseDomain = getBaseDomain(currentDomain);
    const domainCookies = await browser.cookies.getAll({ domain: baseDomain });
    const urlCookies = currentUrl
      ? await browser.cookies.getAll({ url: currentUrl })
      : [];

    const seen = new Set();
    currentCookies = [];
    for (const cookie of [...domainCookies, ...urlCookies]) {
      const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        currentCookies.push(cookie);
      }
    }

    // Sort: auth cookies first, then alphabetical
    currentCookies.sort((a, b) => {
      const aAuth = isAuthCookie(a.name);
      const bAuth = isAuthCookie(b.name);
      if (aAuth && !bAuth) return -1;
      if (!aAuth && bAuth) return 1;
      return a.name.localeCompare(b.name);
    });

    els.cookieCountBadge.textContent = String(currentCookies.length);

    // Auto-select auth cookies
    selectedCookieKeys = new Set();
    for (const cookie of currentCookies) {
      if (isAuthCookie(cookie.name)) {
        selectedCookieKeys.add(cookieKey(cookie));
      }
    }
    if (selectedCookieKeys.size === 0) {
      for (const cookie of currentCookies) {
        selectedCookieKeys.add(cookieKey(cookie));
      }
    }

    renderCookieList();
    updateSelectedCount();

    // Auto-generate session name
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const now = new Date();
    const pretty =
      baseDomain.charAt(0).toUpperCase() + baseDomain.slice(1);
    els.sessionName.value = `${pretty} - ${months[now.getMonth()]} ${now.getFullYear()}`;
  } catch (err) {
    els.cookieCountBadge.textContent = "0";
    els.cookieList.innerHTML =
      '<div class="cookie-item" style="color: var(--text-muted)">Error loading cookies</div>';
    showToast("error", "Cookie loading failed", err.message || "Could not read cookies for this domain.");
  }
}

function renderCookieList() {
  els.cookieList.innerHTML = "";

  if (currentCookies.length === 0) {
    renderEmptyState(els.cookieList, {
      icon: EMPTY_ICONS.cookie,
      title: `No cookies found on ${currentDomain || "this domain"}`,
      description: "This page doesn't set any cookies, or cookies are blocked by browser settings.",
    });
    return;
  }

  for (const cookie of currentCookies) {
    const key = cookieKey(cookie);
    const isAuth = isAuthCookie(cookie.name);

    const item = document.createElement("div");
    item.className = "cookie-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedCookieKeys.has(key);
    checkbox.dataset.cookieKey = key;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedCookieKeys.add(key);
      } else {
        selectedCookieKeys.delete(key);
      }
      bounceCheckbox(checkbox);
      updateSelectedCount();
    });

    const name = document.createElement("span");
    name.className = "cookie-name" + (isAuth ? " auth-cookie" : "");
    name.textContent = cookie.name;
    name.title = `${cookie.name} (${cookie.domain})`;

    const flags = document.createElement("span");
    flags.className = "cookie-flags";

    if (isAuth) {
      const flag = document.createElement("span");
      flag.className = "cookie-flag auth";
      flag.textContent = "Auth";
      flags.appendChild(flag);
    }
    if (cookie.secure) {
      const flag = document.createElement("span");
      flag.className = "cookie-flag secure";
      flag.textContent = "Secure";
      flags.appendChild(flag);
    }
    if (cookie.httpOnly) {
      const flag = document.createElement("span");
      flag.className = "cookie-flag httponly";
      flag.textContent = "HttpOnly";
      flags.appendChild(flag);
    }

    item.appendChild(checkbox);
    item.appendChild(name);
    item.appendChild(flags);

    item.addEventListener("click", (e) => {
      if (e.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change"));
    });

    els.cookieList.appendChild(item);
  }
}

function syncCheckboxes() {
  const checkboxes = els.cookieList.querySelectorAll(
    'input[type="checkbox"]',
  );
  for (const cb of checkboxes) {
    cb.checked = selectedCookieKeys.has(cb.dataset.cookieKey);
  }
}

function updateSelectedCount() {
  const count = selectedCookieKeys.size;
  els.selectedCount.textContent = `${count} selected`;
  els.captureBtn.disabled = count === 0;
  els.openDashboardBtn.disabled = count === 0;
  els.copyBtn.disabled = count === 0;
}

async function handleCapture() {
  if (selectedCookieKeys.size === 0) return;

  const config = await loadConfig();
  if (!config.apiKey) {
    // Show inline auth prompt instead of switching tabs
    els.captureAuthPrompt.classList.remove("hidden");
    els.captureAuthKey.focus();
    return;
  }

  const sessionName = els.sessionName.value.trim() || currentDomain;

  els.captureBtn.disabled = true;
  els.captureBtn.innerHTML = '<span class="spinner"></span> Saving...';
  hideStatus(els.captureStatus);

  try {
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
      els.captureStatus,
      "success",
      `Session saved! ID: <code>${sessionId}</code>`,
    );

    browser.runtime.sendMessage({
      type: "SESSION_SAVED",
      domain: currentDomain,
    });
  } catch (err) {
    showStatus(
      els.captureStatus,
      "error",
      err.message || "Failed to save session.",
    );
    const isNetworkError =
      !navigator.onLine || (err.message && err.message.includes("fetch"));
    showToast(
      "error",
      isNetworkError
        ? "Couldn't reach AlterLab"
        : "Cookie capture failed",
      err.message || "Failed to save session.",
      {
        actionLabel: "Retry",
        onAction: () => handleCapture(),
      },
    );
  } finally {
    els.captureBtn.disabled = false;
    els.captureBtn.innerHTML = "Capture & Send";
  }
}

/**
 * Open the AlterLab dashboard sessions page with captured cookies pre-filled
 * via URL deep link. Uses base64url encoding for the cookie payload.
 * If the total URL exceeds ~7500 chars, filters to auth-relevant cookies only.
 */
async function handleOpenDashboard() {
  if (selectedCookieKeys.size === 0) return;

  const config = await loadConfig();
  const sessionName = els.sessionName.value.trim() || currentDomain;

  // Build cookie dict from selected cookies
  const cookieDict = {};
  for (const cookie of currentCookies) {
    if (selectedCookieKeys.has(cookieKey(cookie))) {
      cookieDict[cookie.name] = cookie.value;
    }
  }

  // Base64url encode the cookies JSON
  const MAX_URL_LENGTH = 7500;
  let cookieJson = JSON.stringify(cookieDict);
  let encoded = btoa(cookieJson).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  // Build the deep link URL
  const baseUrl = `${config.apiUrl}/dashboard/tools/sessions`;
  const params = new URLSearchParams({
    action: "create",
    domain: currentDomain,
    name: sessionName,
    cookies: encoded,
  });

  let fullUrl = `${baseUrl}?${params.toString()}`;

  // If URL is too long, filter to auth cookies only
  if (fullUrl.length > MAX_URL_LENGTH) {
    const authCookieDict = {};
    for (const cookie of currentCookies) {
      if (selectedCookieKeys.has(cookieKey(cookie)) && isAuthCookie(cookie.name)) {
        authCookieDict[cookie.name] = cookie.value;
      }
    }
    cookieJson = JSON.stringify(authCookieDict);
    encoded = btoa(cookieJson).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    params.set("cookies", encoded);
    params.set("filtered", "1"); // Signal that some cookies were omitted
    fullUrl = `${baseUrl}?${params.toString()}`;

    // If still too long after filtering, warn and abort
    if (fullUrl.length > MAX_URL_LENGTH) {
      showToast("error", "Too many cookies", "Cookie data is too large for a URL deep link. Use 'Capture & Send' instead.");
      return;
    }
  }

  // Open the dashboard in a new tab
  try {
    await browser.tabs.create({ url: fullUrl });
    showStatus(
      els.captureStatus,
      "success",
      "Dashboard opened with cookies pre-filled!",
    );
  } catch (err) {
    showToast("error", "Failed to open dashboard", err.message || "Could not open a new tab.");
  }
}

async function handleCopyJson() {
  if (selectedCookieKeys.size === 0) return;

  const cookieDict = {};
  for (const cookie of currentCookies) {
    if (selectedCookieKeys.has(cookieKey(cookie))) {
      cookieDict[cookie.name] = cookie.value;
    }
  }

  try {
    await navigator.clipboard.writeText(JSON.stringify(cookieDict, null, 2));
  } catch (err) {
    // Fallback to execCommand
    try {
      const ta = document.createElement("textarea");
      ta.value = JSON.stringify(cookieDict, null, 2);
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (fallbackErr) {
      showToast("error", "Copy failed", "Could not copy to clipboard.");
      return;
    }
  }
  animateCopyButton(els.copyBtn);
}

// ---------------------------------------------------------------------------
// Cookie Inspector Tab
// ---------------------------------------------------------------------------

function bindCookieInspectorEvents() {
  // Search — debounced
  let searchTimer = null;
  els.ciSearchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      ciSearchQuery = els.ciSearchInput.value.trim().toLowerCase();
      renderInspectorCookies();
    }, 150);
  });

  // Sort button — cycles through fields; first click on a field = ascending,
  // second click on same field = descending, third click = advance to next field ascending
  const sortFields = ["name", "domain", "expiry", "size"];
  const sortLabels = { name: "Name", domain: "Domain", expiry: "Expiry", size: "Size" };
  els.ciSortBtn.addEventListener("click", () => {
    if (ciSortAsc) {
      // Same field, toggle to descending
      ciSortAsc = false;
    } else {
      // Advance to next field, reset to ascending
      const idx = sortFields.indexOf(ciSortField);
      ciSortField = sortFields[(idx + 1) % sortFields.length];
      ciSortAsc = true;
    }
    els.ciSortBtn.textContent = sortLabels[ciSortField] + (ciSortAsc ? " \u2191" : " \u2193");
    renderInspectorCookies();
  });

  // Filter chips
  document.querySelectorAll(".ci-filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".ci-filter-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      ciActiveFilter = chip.dataset.filter;
      renderInspectorCookies();
    });
  });

  // Subdomains toggle
  els.ciSubdomains.addEventListener("change", () => {
    loadInspectorCookies();
  });

  // Export buttons
  els.ciExportJson.addEventListener("click", () => ciExport("json"));
  els.ciExportNetscape.addEventListener("click", () => ciExport("netscape"));
  els.ciExportKV.addEventListener("click", () => ciExport("kv"));

  // Bulk delete
  els.ciBulkDelete.addEventListener("click", ciBulkDeleteAll);
}

async function loadInspectorCookies() {
  if (!currentDomain) return;

  try {
    const includeSubdomains = els.ciSubdomains.checked;
    let cookies = [];

    if (includeSubdomains) {
      const baseDomain = getBaseDomain(currentDomain);
      const domainCookies = await browser.cookies.getAll({ domain: baseDomain });
      const urlCookies = currentUrl
        ? await browser.cookies.getAll({ url: currentUrl })
        : [];
      const seen = new Set();
      for (const cookie of [...domainCookies, ...urlCookies]) {
        const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          cookies.push(cookie);
        }
      }
    } else {
      // Exact domain only
      const urlCookies = currentUrl
        ? await browser.cookies.getAll({ url: currentUrl })
        : await browser.cookies.getAll({ domain: currentDomain });
      const seen = new Set();
      for (const cookie of urlCookies) {
        const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          cookies.push(cookie);
        }
      }
    }

    ciAllCookies = cookies;
    updateInspectorStats();
    renderInspectorCookies();
  } catch (err) {
    ciAllCookies = [];
    renderEmptyState(els.ciCookieList, {
      icon: EMPTY_ICONS.cookie,
      title: "Error loading cookies",
      description: "Could not access cookie data for this page.",
    });
    showToast("error", "Cookie inspector error", err.message || "Failed to load cookies for inspection.");
  }
}

function updateInspectorStats() {
  const total = ciAllCookies.length;
  const authCount = ciAllCookies.filter((c) => isAuthCookie(c.name)).length;
  const expiredCount = ciAllCookies.filter((c) => isCookieExpired(c)).length;
  const totalSize = ciAllCookies.reduce((sum, c) => sum + cookieByteSize(c), 0);

  els.ciTotalCount.textContent = String(total);
  els.ciAuthCount.textContent = String(authCount);
  els.ciExpiredCount.textContent = String(expiredCount);
  els.ciTotalSize.textContent = formatBytes(totalSize);
}

function getFilteredSortedCookies() {
  let filtered = [...ciAllCookies];

  // Apply filter
  if (ciActiveFilter === "auth") {
    filtered = filtered.filter((c) => isAuthCookie(c.name));
  } else if (ciActiveFilter === "secure") {
    filtered = filtered.filter((c) => c.secure);
  } else if (ciActiveFilter === "httponly") {
    filtered = filtered.filter((c) => c.httpOnly);
  } else if (ciActiveFilter === "expired") {
    filtered = filtered.filter((c) => isCookieExpired(c));
  } else if (ciActiveFilter === "session") {
    filtered = filtered.filter((c) => c.session || !c.expirationDate);
  }

  // Apply search
  if (ciSearchQuery) {
    filtered = filtered.filter((c) => {
      return (
        c.name.toLowerCase().includes(ciSearchQuery) ||
        c.domain.toLowerCase().includes(ciSearchQuery) ||
        c.path.toLowerCase().includes(ciSearchQuery) ||
        c.value.toLowerCase().includes(ciSearchQuery)
      );
    });
  }

  // Sort
  filtered.sort((a, b) => {
    let cmp = 0;
    if (ciSortField === "name") {
      cmp = a.name.localeCompare(b.name);
    } else if (ciSortField === "domain") {
      cmp = a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name);
    } else if (ciSortField === "expiry") {
      const aExp = a.expirationDate || Infinity;
      const bExp = b.expirationDate || Infinity;
      cmp = aExp - bExp;
    } else if (ciSortField === "size") {
      cmp = cookieByteSize(b) - cookieByteSize(a); // largest first
    }
    return ciSortAsc ? cmp : -cmp;
  });

  return filtered;
}

function renderInspectorCookies() {
  const filtered = getFilteredSortedCookies();
  els.ciResultCount.textContent = `${filtered.length} of ${ciAllCookies.length}`;
  els.ciFilteredInfo.textContent =
    ciSearchQuery || ciActiveFilter !== "all"
      ? `Showing ${filtered.length} filtered`
      : `${ciAllCookies.length} cookies`;

  els.ciCookieList.innerHTML = "";

  if (filtered.length === 0) {
    if (ciSearchQuery || ciActiveFilter !== "all") {
      renderEmptyState(els.ciCookieList, {
        icon: EMPTY_ICONS.search,
        title: "No cookies match your search",
        description: "Try a different search term or clear your filters.",
      });
    } else {
      renderEmptyState(els.ciCookieList, {
        icon: EMPTY_ICONS.cookie,
        title: `No cookies found on ${currentDomain || "this domain"}`,
        description: "This page doesn't set any cookies, or cookies are blocked by browser settings.",
      });
    }
    return;
  }

  for (const cookie of filtered) {
    const row = document.createElement("div");
    row.className = "ci-cookie-row";

    const isAuth = isAuthCookie(cookie.name);
    const expired = isCookieExpired(cookie);
    const size = cookieByteSize(cookie);

    // Summary row
    const summary = document.createElement("div");
    summary.className = "ci-cookie-summary";

    // Expand arrow
    const arrow = document.createElement("span");
    arrow.className = "ci-cookie-expand";
    arrow.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';

    // Name
    const nameEl = document.createElement("span");
    nameEl.className = "ci-cookie-name";
    if (isAuth) nameEl.classList.add("auth");
    if (expired) nameEl.classList.add("expired");
    nameEl.textContent = cookie.name;
    nameEl.title = `${cookie.name} (${cookie.domain})`;

    // Size
    const sizeEl = document.createElement("span");
    sizeEl.className = "ci-cookie-size";
    sizeEl.textContent = formatBytes(size);

    // Flags
    const flags = document.createElement("span");
    flags.className = "ci-cookie-flags";

    if (isAuth) {
      const f = document.createElement("span");
      f.className = "ci-flag ci-flag-auth";
      f.textContent = "Auth";
      flags.appendChild(f);
    }
    if (expired) {
      const f = document.createElement("span");
      f.className = "ci-flag ci-flag-expired";
      f.textContent = "Exp";
      flags.appendChild(f);
    }
    if (cookie.secure) {
      const f = document.createElement("span");
      f.className = "ci-flag ci-flag-secure";
      f.textContent = "Sec";
      flags.appendChild(f);
    }
    if (cookie.httpOnly) {
      const f = document.createElement("span");
      f.className = "ci-flag ci-flag-httponly";
      f.textContent = "HO";
      flags.appendChild(f);
    }
    if (cookie.sameSite && cookie.sameSite !== "unspecified") {
      const f = document.createElement("span");
      f.className = "ci-flag ci-flag-samesite";
      f.textContent = sameSiteLabel(cookie.sameSite);
      flags.appendChild(f);
    }
    if (cookie.session || !cookie.expirationDate) {
      const f = document.createElement("span");
      f.className = "ci-flag ci-flag-session";
      f.textContent = "Sess";
      flags.appendChild(f);
    }

    summary.appendChild(arrow);
    summary.appendChild(nameEl);
    summary.appendChild(sizeEl);
    summary.appendChild(flags);

    // Detail panel (hidden by default)
    const detail = document.createElement("div");
    detail.className = "ci-cookie-detail";

    const grid = document.createElement("div");
    grid.className = "ci-detail-grid";

    const fields = [
      ["Name", cookie.name],
      ["Value", cookie.value || "(empty)"],
      ["Domain", cookie.domain],
      ["Path", cookie.path],
      ["Expires", cookie.session ? "Session (browser close)" : formatCookieDate(cookie.expirationDate)],
      ["Size", formatBytes(size)],
      ["Secure", cookie.secure ? "Yes" : "No"],
      ["HttpOnly", cookie.httpOnly ? "Yes" : "No"],
      ["SameSite", sameSiteLabel(cookie.sameSite)],
    ];

    for (const [label, value] of fields) {
      const labelEl = document.createElement("span");
      labelEl.className = "ci-detail-label";
      labelEl.textContent = label;
      const valueEl = document.createElement("span");
      valueEl.className = "ci-detail-value";
      valueEl.textContent = value;
      grid.appendChild(labelEl);
      grid.appendChild(valueEl);
    }

    detail.appendChild(grid);

    // Action buttons inside detail
    const actions = document.createElement("div");
    actions.className = "ci-detail-actions";

    const copyValueBtn = document.createElement("button");
    copyValueBtn.className = "ci-btn-copy-value";
    copyValueBtn.textContent = "Copy value";
    copyValueBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      ciCopyText(cookie.value, copyValueBtn);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "ci-btn-delete";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      ciDeleteCookie(cookie);
    });

    actions.appendChild(copyValueBtn);
    actions.appendChild(deleteBtn);
    detail.appendChild(actions);

    row.appendChild(summary);
    row.appendChild(detail);

    // Toggle expand on summary click
    summary.addEventListener("click", () => {
      row.classList.toggle("expanded");
    });

    els.ciCookieList.appendChild(row);
  }
}

async function ciDeleteCookie(cookie) {
  try {
    const protocol = cookie.secure ? "https" : "http";
    const url = `${protocol}://${cookie.domain.replace(/^\./, "")}${cookie.path}`;
    await browser.cookies.remove({ url, name: cookie.name });
    // Remove from local array
    ciAllCookies = ciAllCookies.filter(
      (c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path),
    );
    updateInspectorStats();
    renderInspectorCookies();
    showStatus(els.ciStatus, "success", `Deleted cookie: ${cookie.name}`);
    setTimeout(() => hideStatus(els.ciStatus), 2000);
    // Also refresh the capture tab cookies
    loadCookies();
  } catch (err) {
    showStatus(els.ciStatus, "error", `Failed to delete: ${err.message}`);
    showToast("error", "Delete failed", `Could not delete cookie: ${err.message}`);
  }
}

async function ciBulkDeleteAll() {
  const filtered = getFilteredSortedCookies();
  if (filtered.length === 0) return;

  const label =
    ciSearchQuery || ciActiveFilter !== "all"
      ? `Delete ${filtered.length} filtered cookies?`
      : `Delete ALL ${filtered.length} cookies for this domain?`;

  // Simple confirm via button text toggle
  if (els.ciBulkDelete.dataset.confirm !== "yes") {
    els.ciBulkDelete.textContent = label;
    els.ciBulkDelete.dataset.confirm = "yes";
    setTimeout(() => {
      els.ciBulkDelete.textContent = "Clear all cookies";
      delete els.ciBulkDelete.dataset.confirm;
    }, 3000);
    return;
  }

  delete els.ciBulkDelete.dataset.confirm;
  els.ciBulkDelete.textContent = "Deleting...";

  let deleted = 0;
  for (const cookie of filtered) {
    try {
      const protocol = cookie.secure ? "https" : "http";
      const url = `${protocol}://${cookie.domain.replace(/^\./, "")}${cookie.path}`;
      await browser.cookies.remove({ url, name: cookie.name });
      deleted++;
    } catch {
      // skip failures
    }
  }

  // Reload
  await loadInspectorCookies();
  await loadCookies();
  els.ciBulkDelete.textContent = "Clear all cookies";
  showStatus(els.ciStatus, "success", `Deleted ${deleted} cookies`);
  setTimeout(() => hideStatus(els.ciStatus), 2000);
}

async function ciExport(format) {
  const filtered = getFilteredSortedCookies();
  if (filtered.length === 0) return;

  let text = "";
  let btnEl = null;

  if (format === "json") {
    const arr = filtered.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: sameSiteLabel(c.sameSite),
      expirationDate: c.expirationDate || null,
      session: c.session || !c.expirationDate,
    }));
    text = JSON.stringify(arr, null, 2);
    btnEl = els.ciExportJson;
  } else if (format === "netscape") {
    text = exportNetscapeFormat(filtered);
    btnEl = els.ciExportNetscape;
  } else if (format === "kv") {
    text = exportKeyValueFormat(filtered);
    btnEl = els.ciExportKV;
  }

  ciCopyText(text, btnEl);
}

function ciCopyText(text, btnEl) {
  try {
    navigator.clipboard.writeText(text).then(() => {
      if (btnEl) animateCopyButtonText(btnEl);
    });
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    if (btnEl) animateCopyButtonText(btnEl);
  }
}

// ---------------------------------------------------------------------------
// Headers Tab — Network Request/Response Header Viewer
// ---------------------------------------------------------------------------

/** Security-relevant response header names (highlighted in the UI). */
const SECURITY_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "x-frame-options",
  "x-content-type-options",
  "x-xss-protection",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "x-permitted-cross-domain-policies",
]);

function bindHeadersEvents() {
  els.hdrSearchInput.addEventListener("input", () => {
    hdrSearchQuery = els.hdrSearchInput.value.trim().toLowerCase();
    renderHeadersList();
  });

  els.hdrClearBtn.addEventListener("click", () => {
    if (hdrCurrentTabId) {
      browser.runtime.sendMessage({
        type: "CLEAR_NETWORK_REQUESTS",
        tabId: hdrCurrentTabId,
      });
    }
    hdrAllRequests = [];
    renderHeadersList();
  });

  // Type filter chips
  els.hdrFilters.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-hdr-filter]");
    if (!chip) return;
    hdrActiveFilter = chip.dataset.hdrFilter;
    els.hdrFilters
      .querySelectorAll(".hdr-filter-chip")
      .forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    renderHeadersList();
  });
}

async function loadNetworkRequests() {
  if (!hdrCurrentTabId) return;
  try {
    const response = await browser.runtime.sendMessage({
      type: "GET_NETWORK_REQUESTS",
      tabId: hdrCurrentTabId,
    });
    hdrAllRequests = response && response.requests ? response.requests : [];
    renderHeadersList();
  } catch {
    hdrAllRequests = [];
    renderHeadersList();
  }
}

/**
 * Map webRequest resource types to filter categories.
 */
function hdrTypeCategory(type) {
  switch (type) {
    case "xmlhttprequest":
      return "xhr";
    case "main_frame":
    case "sub_frame":
      return "document";
    case "script":
      return "script";
    case "stylesheet":
      return "stylesheet";
    case "image":
    case "imageset":
      return "image";
    case "font":
      return "font";
    default:
      return "other";
  }
}

function getFilteredRequests() {
  let filtered = hdrAllRequests;

  // Type filter
  if (hdrActiveFilter !== "all") {
    filtered = filtered.filter(
      (r) => hdrTypeCategory(r.type) === hdrActiveFilter,
    );
  }

  // Search filter (searches URL and header names/values)
  if (hdrSearchQuery) {
    filtered = filtered.filter((r) => {
      if (r.url.toLowerCase().includes(hdrSearchQuery)) return true;
      if (r.method.toLowerCase().includes(hdrSearchQuery)) return true;
      for (const h of r.requestHeaders || []) {
        if (h.name.toLowerCase().includes(hdrSearchQuery)) return true;
        if (h.value.toLowerCase().includes(hdrSearchQuery)) return true;
      }
      for (const h of r.responseHeaders || []) {
        if (h.name.toLowerCase().includes(hdrSearchQuery)) return true;
        if (h.value.toLowerCase().includes(hdrSearchQuery)) return true;
      }
      return false;
    });
  }

  return filtered;
}

function renderHeadersList() {
  const filtered = getFilteredRequests();
  els.hdrRequestCount.textContent = String(hdrAllRequests.length);
  if (els.hdrRequestCountInner) els.hdrRequestCountInner.textContent = String(hdrAllRequests.length);
  els.hdrFilteredCount.textContent = String(filtered.length);

  if (filtered.length === 0) {
    els.hdrRequestList.innerHTML = `
      <div class="hdr-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 12h16"/><path d="M4 6h16"/><path d="M4 18h12"/>
        </svg>
        <p>${hdrAllRequests.length === 0 ? "Navigate to a page to capture network requests." : "No requests match your filter."}</p>
      </div>`;
    return;
  }

  // Render in reverse chronological order (newest first)
  const frag = document.createDocumentFragment();
  for (let i = filtered.length - 1; i >= 0; i--) {
    frag.appendChild(createRequestRow(filtered[i]));
  }
  els.hdrRequestList.innerHTML = "";
  els.hdrRequestList.appendChild(frag);
}

function createRequestRow(req) {
  const row = document.createElement("div");
  row.className = "hdr-request-row";

  // Extract short path from URL for display
  let displayUrl;
  try {
    const u = new URL(req.url);
    displayUrl = u.pathname + u.search;
    if (displayUrl.length > 80) {
      displayUrl = displayUrl.substring(0, 77) + "...";
    }
  } catch {
    displayUrl = req.url;
  }

  const methodClass =
    "hdr-method hdr-method-" + req.method.toLowerCase();
  const statusClass = getStatusClass(req.statusCode);
  const durationText = req.duration
    ? req.duration < 1000
      ? Math.round(req.duration) + "ms"
      : (req.duration / 1000).toFixed(1) + "s"
    : "";

  // Summary row
  const summary = document.createElement("div");
  summary.className = "hdr-request-summary";
  summary.innerHTML = `
    <svg class="hdr-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
    <span class="${methodClass}">${escapeHtml(req.method)}</span>
    <span class="hdr-status ${statusClass}">${req.statusCode || "ERR"}</span>
    <span class="hdr-url" title="${escapeHtml(req.url)}">${escapeHtml(displayUrl)}</span>
    <span class="hdr-type-badge">${escapeHtml(hdrTypeCategory(req.type))}</span>
    <span class="hdr-duration">${durationText}</span>
  `;

  summary.addEventListener("click", () => {
    row.classList.toggle("expanded");
  });

  // Detail section (hidden by default)
  const detail = document.createElement("div");
  detail.className = "hdr-request-detail";

  // Full URL
  detail.innerHTML = `
    <div class="hdr-detail-section">
      <div class="hdr-detail-title">
        URL
        <div class="hdr-detail-actions">
          <button class="hdr-copy-btn" data-copy-type="curl" title="Copy as cURL">cURL</button>
          <button class="hdr-copy-btn" data-copy-type="python" title="Copy as Python requests">Python</button>
          <button class="hdr-copy-btn" data-copy-type="node" title="Copy as Node.js fetch">Node</button>
        </div>
      </div>
      <div class="hdr-header-value" style="margin-bottom: 8px; font-size: 10px;">${escapeHtml(req.url)}</div>
    </div>
    <div class="hdr-detail-section">
      <div class="hdr-detail-title">Request Headers (${(req.requestHeaders || []).length})</div>
      <div class="hdr-header-grid">${renderHeaderGrid(req.requestHeaders || [])}</div>
    </div>
    <div class="hdr-detail-section">
      <div class="hdr-detail-title">
        Response Headers (${(req.responseHeaders || []).length})
      </div>
      <div class="hdr-header-grid">${renderHeaderGrid(req.responseHeaders || [], true)}</div>
    </div>
  `;

  // Bind copy buttons
  detail.querySelectorAll(".hdr-copy-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const copyType = btn.dataset.copyType;
      let text;
      if (copyType === "curl") {
        text = generateCurl(req);
      } else if (copyType === "python") {
        text = generatePython(req);
      } else {
        text = generateNode(req);
      }
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = orig;
        }, 1200);
      });
    });
  });

  row.appendChild(summary);
  row.appendChild(detail);
  return row;
}

function getStatusClass(code) {
  if (!code || code === 0) return "hdr-status-0";
  if (code < 300) return "hdr-status-2xx";
  if (code < 400) return "hdr-status-3xx";
  if (code < 500) return "hdr-status-4xx";
  return "hdr-status-5xx";
}

function renderHeaderGrid(headers, highlightSecurity) {
  if (headers.length === 0) {
    return '<span style="color: var(--text-muted); font-size: 11px;">No headers</span>';
  }
  return headers
    .map((h) => {
      const isSec =
        highlightSecurity &&
        SECURITY_HEADERS.has(h.name.toLowerCase());
      return `<span class="hdr-header-name${isSec ? " security" : ""}">${escapeHtml(h.name)}</span><span class="hdr-header-value">${escapeHtml(h.value)}</span>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Code Generation (cURL, Python, Node.js)
// ---------------------------------------------------------------------------

function generateCurl(req) {
  const parts = ["curl"];

  if (req.method !== "GET") {
    parts.push(`-X ${req.method}`);
  }

  parts.push(`'${req.url}'`);

  for (const h of req.requestHeaders || []) {
    // Skip pseudo-headers and host (curl adds its own)
    const name = h.name.toLowerCase();
    if (name.startsWith(":")) continue;
    parts.push(`-H '${h.name}: ${h.value.replace(/'/g, "'\\''")}'`);
  }

  // Include request body for POST/PUT/PATCH requests
  if (req.requestBody) {
    parts.push(`-d '${req.requestBody.replace(/'/g, "'\\''")}'`);
  }

  return parts.join(" \\\n  ");
}

function generatePython(req) {
  const lines = ["# Via AlterLab Connect \u2014 alterlab.io", "import requests", ""];

  const headers = {};
  for (const h of req.requestHeaders || []) {
    const name = h.name.toLowerCase();
    if (name.startsWith(":") || name === "host" || name === "content-length")
      continue;
    headers[h.name] = h.value;
  }

  lines.push(`headers = ${JSON.stringify(headers, null, 4)}`);
  lines.push("");

  const method = req.method.toLowerCase();

  // Determine if the body looks like JSON to use json= instead of data=
  let bodyParam = null;
  if (req.requestBody) {
    try {
      const parsed = JSON.parse(req.requestBody);
      bodyParam = `    json=${JSON.stringify(parsed, null, 4).replace(/\n/g, "\n    ")},`;
    } catch {
      bodyParam = `    data=${JSON.stringify(req.requestBody)},`;
    }
  }

  lines.push(`response = requests.${method}(`);
  lines.push(`    "${req.url}",`);
  lines.push(`    headers=headers,`);
  if (bodyParam) {
    lines.push(bodyParam);
  }
  lines.push(`)`, "", "print(response.status_code)", "print(response.text)");

  return lines.join("\n");
}

function generateNode(req) {
  const lines = ["// Via AlterLab Connect \u2014 alterlab.io", ""];

  const headers = {};
  for (const h of req.requestHeaders || []) {
    const name = h.name.toLowerCase();
    if (name.startsWith(":") || name === "host" || name === "content-length")
      continue;
    headers[h.name] = h.value;
  }

  // Build fetch options with optional body
  let bodyLine = null;
  if (req.requestBody) {
    try {
      const parsed = JSON.parse(req.requestBody);
      bodyLine = `  body: JSON.stringify(${JSON.stringify(parsed, null, 4).replace(/\n/g, "\n  ")}),`;
    } catch {
      bodyLine = `  body: ${JSON.stringify(req.requestBody)},`;
    }
  }

  lines.push(`const response = await fetch("${req.url}", {`);
  lines.push(`  method: "${req.method}",`);
  lines.push(`  headers: ${JSON.stringify(headers, null, 4).replace(/\n/g, "\n  ")},`);
  if (bodyLine) {
    lines.push(bodyLine);
  }
  lines.push(
    `});`,
    "",
    "console.log(response.status);",
    "const respBody = await response.text();",
    "console.log(respBody);",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Scrape Tab — One-Shot "Scrape This Page"
// ---------------------------------------------------------------------------

let scrapeSelectedFormat = "markdown";
let scrapeLastResult = null;

function bindScrapeEvents() {
  // Format picker
  els.scrapeFormatGrid.querySelectorAll(".scrape-format-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.scrapeFormatGrid
        .querySelectorAll(".scrape-format-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      scrapeSelectedFormat = btn.dataset.format;
    });
  });

  // Run button
  els.scrapeRunBtn.addEventListener("click", handleScrapeRun);

  // Copy result
  els.scrapeCopyBtn.addEventListener("click", handleScrapeCopy);

  // Download result
  els.scrapeDownloadBtn.addEventListener("click", handleScrapeDownload);

  // Upsell "Connect your API key" link → switch to Account tab
  els.upsellConnectLink.addEventListener("click", (e) => {
    e.preventDefault();
    const accountBtn = document.querySelector('.tab-bar button[data-tab="account"]');
    if (accountBtn) accountBtn.click();
  });

  // Initialize usage pill
  updateScrapeUsagePill();
}

async function updateScrapeUsagePill() {
  // Show a safe default synchronously so the pill is never empty while
  // async storage calls resolve.
  if (!els.scrapeUsagePill.textContent) {
    els.scrapeUsagePill.textContent = `${FREE_SCRAPE_LIMIT} free`;
  }

  const config = await loadConfig();
  if (config.apiKey) {
    els.scrapeUsagePill.textContent = "Connected";
    els.scrapeUsagePill.style.borderColor = "var(--success)";
    els.scrapeUsagePill.style.color = "var(--success)";
  } else {
    const { used, limit } = await checkFreeScrapeAllowance();
    const remaining = limit - used;
    els.scrapeUsagePill.textContent = `${remaining}/${limit} free`;
    if (remaining <= 1) {
      els.scrapeUsagePill.style.borderColor = "var(--warning)";
      els.scrapeUsagePill.style.color = "var(--warning)";
    }
  }
}

async function handleScrapeRun() {
  const config = await loadConfig();

  // Check free tier allowance for anonymous users
  if (!config.apiKey) {
    const { allowed } = await checkFreeScrapeAllowance();
    if (!allowed) {
      // Show upsell, hide results
      els.scrapeUpsell.classList.remove("hidden");
      els.scrapeResultsCard.classList.add("hidden");
      hideStatus(els.scrapeStatus);
      return;
    }
  }

  // Handle screenshot format — use Chrome API
  if (scrapeSelectedFormat === "screenshot") {
    await handleScreenshotCapture();
    return;
  }

  // Disable button, show loading
  els.scrapeRunBtn.disabled = true;
  els.scrapeRunBtn.innerHTML =
    '<span class="spinner"></span> Scraping...';
  hideStatus(els.scrapeStatus);
  els.scrapeResultsCard.classList.add("hidden");
  els.scrapeUpsell.classList.add("hidden");

  // Show a "processing" hint after 3 seconds in case the job is async-queued
  let processingHintTimer = setTimeout(() => {
    if (els.scrapeRunBtn.disabled) {
      els.scrapeRunBtn.innerHTML =
        '<span class="spinner"></span> Processing...';
      showStatus(
        els.scrapeStatus,
        "info",
        "Job queued — waiting for results\u2026",
      );
    }
  }, 3000);

  try {
    const deviceId = await getDeviceId();

    const response = await browser.runtime.sendMessage({
      type: "SCRAPE_PAGE",
      url: currentUrl,
      format: scrapeSelectedFormat,
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      deviceId,
    });

    clearTimeout(processingHintTimer);
    hideStatus(els.scrapeStatus);

    if (response && response.error) {
      showStatus(els.scrapeStatus, "error", escapeHtml(response.error));
      showToast("error", "Scrape failed", response.error);
    } else if (response && response.content) {
      // Store result for copy/download
      scrapeLastResult = {
        content: response.content,
        format: scrapeSelectedFormat,
        url: currentUrl,
        jobId: response.jobId,
      };

      // Display results
      els.scrapeResultsContent.textContent = response.content;
      els.scrapeResultsCard.classList.remove("hidden");

      // Increment usage for anonymous users
      if (!config.apiKey) {
        await incrementScrapeUsage();
        updateScrapeUsagePill();
      }

      showToast("success", "Page scraped", `${scrapeSelectedFormat.toUpperCase()} content extracted`);
    } else {
      showStatus(els.scrapeStatus, "error", "No content returned from scrape.");
    }
  } catch (err) {
    clearTimeout(processingHintTimer);
    showStatus(
      els.scrapeStatus,
      "error",
      err.message || "Failed to scrape page.",
    );
    showToast("error", "Scrape error", err.message || "Unexpected error");
  } finally {
    els.scrapeRunBtn.disabled = false;
    els.scrapeRunBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      Scrape This Page`;
  }
}

async function handleScreenshotCapture() {
  els.scrapeRunBtn.disabled = true;
  els.scrapeRunBtn.innerHTML =
    '<span class="spinner"></span> Capturing...';
  hideStatus(els.scrapeStatus);
  els.scrapeResultsCard.classList.add("hidden");
  els.scrapeUpsell.classList.add("hidden");

  try {
    // Request screenshot from background service worker
    // (captureVisibleTab must run in service worker context)
    const response = await browser.runtime.sendMessage({
      type: "CAPTURE_SCREENSHOT",
    });

    if (response && response.error) {
      throw new Error(response.error);
    }

    const dataUrl = response.dataUrl;

    scrapeLastResult = {
      content: dataUrl,
      format: "screenshot",
      url: currentUrl,
      jobId: null,
    };

    // Display screenshot
    els.scrapeResultsContent.innerHTML = `<img class="scrape-screenshot" src="${dataUrl}" alt="Page screenshot" />`;
    els.scrapeResultsCard.classList.remove("hidden");

    // Increment usage for anonymous users
    const config = await loadConfig();
    if (!config.apiKey) {
      await incrementScrapeUsage();
      updateScrapeUsagePill();
    }

    showToast("success", "Screenshot captured", "Viewport captured as PNG");
  } catch (err) {
    showStatus(
      els.scrapeStatus,
      "error",
      err.message || "Failed to capture screenshot.",
    );
    showToast("error", "Screenshot failed", err.message || "Could not capture tab");
  } finally {
    els.scrapeRunBtn.disabled = false;
    els.scrapeRunBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      Scrape This Page`;
  }
}

async function handleScrapeCopy() {
  if (!scrapeLastResult) return;

  try {
    await navigator.clipboard.writeText(scrapeLastResult.content);
    showToast("success", "Copied", "Content copied to clipboard");
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = scrapeLastResult.content;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    showToast("success", "Copied", "Content copied to clipboard");
  }
}

function handleScrapeDownload() {
  if (!scrapeLastResult) return;

  const domain = currentDomain || "page";
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");

  if (scrapeLastResult.format === "screenshot") {
    // Download screenshot as PNG
    const link = document.createElement("a");
    link.href = scrapeLastResult.content;
    link.download = `${domain}-${timestamp}.png`;
    link.click();
  } else {
    const extensions = { markdown: "md", html: "html", json: "json" };
    const ext = extensions[scrapeLastResult.format] || "txt";
    const blob = new Blob([scrapeLastResult.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${domain}-${timestamp}.${ext}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  showToast("success", "Downloaded", `File saved as ${scrapeLastResult.format}`);
}

// ---------------------------------------------------------------------------
// Score-to-Tier Mapping
// ---------------------------------------------------------------------------

function scoreToTier(score) {
  if (score == null || score <= 30) return 1;
  if (score <= 60) return 2;
  if (score <= 80) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Page-Level Snippet Generation (for Inspect & Job export)
// ---------------------------------------------------------------------------

function generatePageCurl(url, apiKey) {
  const key = apiKey || "YOUR_API_KEY";
  return [
    "curl -X POST https://alterlab.io/api/v1/scrape \\",
    `  -H 'X-API-Key: ${key}' \\`,
    "  -H 'Content-Type: application/json' \\",
    `  -d '${JSON.stringify({ url })}'`,
  ].join("\n");
}

function generatePagePython(url, tier, apiKey) {
  const key = apiKey || "YOUR_API_KEY";
  const body = { url };
  if (tier > 1) body.tier = tier;

  return [
    "# Via AlterLab Connect \u2014 alterlab.io",
    "import requests",
    "",
    `API_KEY = "${key}"`,
    "",
    "response = requests.post(",
    '    "https://alterlab.io/api/v1/scrape",',
    `    headers={"X-API-Key": API_KEY, "Content-Type": "application/json"},`,
    `    json=${JSON.stringify(body, null, 4).replace(/\n/g, "\n    ")},`,
    ")",
    "",
    "print(response.status_code)",
    "print(response.json())",
  ].join("\n");
}

function generatePageNode(url, tier, apiKey) {
  const key = apiKey || "YOUR_API_KEY";
  const body = { url };
  if (tier > 1) body.tier = tier;

  return [
    "// Via AlterLab Connect \u2014 alterlab.io",
    "",
    `const API_KEY = "${key}";`,
    "",
    'const response = await fetch("https://alterlab.io/api/v1/scrape", {',
    '  method: "POST",',
    "  headers: {",
    `    "X-API-Key": API_KEY,`,
    '    "Content-Type": "application/json",',
    "  },",
    `  body: JSON.stringify(${JSON.stringify(body, null, 4).replace(/\n/g, "\n  ")}),`,
    "});",
    "",
    "console.log(response.status);",
    "const data = await response.json();",
    "console.log(data);",
  ].join("\n");
}

function generatePageAlterLab(url, tier, apiKey) {
  const key = apiKey || "YOUR_API_KEY";
  const body = { url, formats: ["text", "markdown"] };
  if (tier > 1) body.tier = tier;

  return [
    "# AlterLab API — Scrape Config",
    `# Auto-selected Tier ${tier} based on Scrape Score`,
    "# Via AlterLab Connect \u2014 alterlab.io",
    "",
    `POST https://alterlab.io/api/v1/scrape`,
    `X-API-Key: ${key}`,
    "Content-Type: application/json",
    "",
    JSON.stringify(body, null, 2),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Export Event Binding (Inspect tab + Job tab)
// ---------------------------------------------------------------------------

function bindExportEvents() {
  // Inspect tab export buttons
  els.exportBtnRow.querySelectorAll(".export-fmt-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleExportClick(btn, "inspect"));
  });
  els.exportCopyBtn.addEventListener("click", () => {
    copySnippetText(els.exportSnippetPre, els.exportCopyBtn);
  });

  // Job tab export buttons
  els.jobExportBtnRow.querySelectorAll(".export-fmt-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleExportClick(btn, "job"));
  });
  els.jobExportCopyBtn.addEventListener("click", () => {
    copySnippetText(els.jobExportSnippetPre, els.jobExportCopyBtn);
  });

  // Share Report button
  if (els.shareReportBtn) {
    els.shareReportBtn.addEventListener("click", handleShareReport);
  }
  if (els.shareReportCopyBtn) {
    els.shareReportCopyBtn.addEventListener("click", () => {
      const url = els.shareReportUrl.value;
      navigator.clipboard.writeText(url).then(() => {
        els.shareReportCopyBtn.textContent = "Copied!";
        setTimeout(() => { els.shareReportCopyBtn.textContent = "Copy"; }, 1500);
      }).catch(() => {
        showToast("error", "Copy failed", "Could not copy to clipboard.");
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Share Report
// ---------------------------------------------------------------------------

async function handleShareReport() {
  if (!currentAnalysis) {
    showToast("warning", "No analysis", "Analyze a page first before sharing.");
    return;
  }

  if (currentAnalysis.score == null) {
    showToast("warning", "Incomplete analysis", "Wait for scoring to complete before sharing.");
    return;
  }

  const config = await loadConfig();
  const apiUrl = config.apiUrl || ALTERLAB_DEFAULT_API_URL;

  els.shareReportBtn.disabled = true;
  els.shareReportBtn.innerHTML = '<span class="spinner"></span> Generating...';
  els.shareReportResult.style.display = "none";
  hideStatus(els.shareReportStatus);

  try {
    // Compute credit estimates
    const credits = estimateCredits(currentAnalysis.score);

    // Check if page has login wall or cookie gate signals
    const signals = currentAnalysis.signals || [];
    const hasLoginWall = signals.some((s) => /login\s*wall/i.test(s));
    const hasCookieGate = signals.some((s) => /cookie\s*(consent|gate)/i.test(s));

    const payload = {
      domain: currentDomain,
      url: currentUrl,
      title: currentAnalysis.title || document.title || currentDomain,
      score: currentAnalysis.score,
      signals: currentAnalysis.signals || [],
      anti_bot_stack: currentAnalysis.antiBotStack || currentAnalysis.antiBot || [],
      tech_stack: currentAnalysis.techStack || null,
      pagination: currentAnalysis.pagination || null,
      api_endpoints: currentAnalysis.apiEndpoints || [],
      meta: currentAnalysis.meta || null,
      cookie_count: 0,
      has_login_wall: hasLoginWall,
      has_cookie_gate: hasCookieGate,
      estimated_credits: credits,
    };

    // Try to get cookie count for the domain
    try {
      const cookieResponse = await browser.runtime.sendMessage({
        type: "GET_COOKIES",
        domain: currentDomain,
        url: currentUrl,
      });
      if (cookieResponse && cookieResponse.cookies) {
        payload.cookie_count = cookieResponse.cookies.length;
      }
    } catch {
      // Cookie count is optional — continue without it
    }

    const resp = await fetch(`${apiUrl}/api/v1/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.detail || `API error (HTTP ${resp.status})`);
    }

    const result = await resp.json();
    const reportUrl = result.url || `${apiUrl}/report/${result.id}`;

    els.shareReportUrl.value = reportUrl;
    els.shareReportResult.style.display = "block";
    showStatus(els.shareReportStatus, "success", "Report created! Share the link.");
    showToast("success", "Report created", "Shareable link ready to copy.");
  } catch (err) {
    showStatus(
      els.shareReportStatus,
      "error",
      err.message || "Failed to create report.",
    );
    showToast("error", "Report failed", err.message || "Could not create report.");
  } finally {
    els.shareReportBtn.disabled = false;
    els.shareReportBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="18" cy="5" r="3"/>
        <circle cx="6" cy="12" r="3"/>
        <circle cx="18" cy="19" r="3"/>
        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
        <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
      </svg>
      Generate Shareable Link`;
  }
}

async function handleExportClick(btn, source) {
  const fmt = btn.dataset.exportFmt || btn.dataset.jobExportFmt;
  const isJob = source === "job";
  const btnRow = isJob ? els.jobExportBtnRow : els.exportBtnRow;
  const snippetBox = isJob ? els.jobExportSnippetBox : els.exportSnippetBox;
  const snippetPre = isJob ? els.jobExportSnippetPre : els.exportSnippetPre;

  // Toggle active state
  const wasActive = btn.classList.contains("active");
  btnRow.querySelectorAll(".export-fmt-btn").forEach((b) => b.classList.remove("active"));

  if (wasActive) {
    snippetBox.classList.remove("visible");
    return;
  }

  btn.classList.add("active");

  // Get API key for substitution
  const config = await loadConfig();
  const apiKey = config.apiKey || "";
  const url = currentUrl || "https://example.com";
  const score = currentAnalysis ? currentAnalysis.score : null;
  const tier = scoreToTier(score);

  let snippet = "";
  switch (fmt) {
    case "curl":
      snippet = generatePageCurl(url, apiKey);
      break;
    case "python":
      snippet = generatePagePython(url, tier, apiKey);
      break;
    case "node":
      snippet = generatePageNode(url, tier, apiKey);
      break;
    case "alterlab":
      snippet = generatePageAlterLab(url, tier, apiKey);
      break;
  }

  snippetPre.textContent = snippet;
  snippetBox.classList.add("visible");
}

function copySnippetText(preEl, btnEl) {
  const text = preEl.textContent;
  navigator.clipboard.writeText(text).then(() => {
    const orig = btnEl.textContent;
    btnEl.textContent = "Copied!";
    setTimeout(() => {
      btnEl.textContent = orig;
    }, 1200);
  }).catch(() => {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    btnEl.textContent = "Copied!";
    setTimeout(() => {
      btnEl.textContent = "Copy";
    }, 1200);
  });
}

// ---------------------------------------------------------------------------
// Job Tab — Scrape Job Builder
// ---------------------------------------------------------------------------

function bindJobEvents() {
  els.submitJobBtn.addEventListener("click", handleSubmitJob);
  els.copyJobBtn.addEventListener("click", handleCopyJob);
}

function updateJobPreview(analysis) {
  const job = {
    url: currentUrl,
    formats: ["text", "markdown"],
  };

  // Add session if we have cookies selected
  if (selectedCookieKeys.size > 0) {
    job.use_session = true;
  }

  // Suggest tier based on score
  if (analysis && analysis.score > 60) {
    job.tier = 4;
  } else if (analysis && analysis.score > 30) {
    job.tier = 3;
  }

  els.jobPreview.textContent = JSON.stringify(job, null, 2);
  els.submitJobBtn.disabled = false;

  // Show export card whenever job preview is ready
  els.jobExportCard.style.display = "block";
}

async function handleSubmitJob() {
  const config = await loadConfig();
  if (!config.apiKey) {
    // Show inline auth prompt instead of switching tabs
    els.jobAuthPrompt.classList.remove("hidden");
    els.jobAuthKey.focus();
    return;
  }

  els.submitJobBtn.disabled = true;
  els.submitJobBtn.innerHTML = '<span class="spinner"></span> Submitting...';
  hideStatus(els.jobStatus);

  try {
    const job = JSON.parse(els.jobPreview.textContent);

    const resp = await fetch(`${config.apiUrl}/api/v1/scrape`, {
      method: "POST",
      headers: {
        "X-API-Key": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(job),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.detail || `API error (HTTP ${resp.status})`);
    }

    const result = await resp.json();
    const jobId = result.job_id || result.id || "submitted";

    showStatus(
      els.jobStatus,
      "success",
      `Job submitted! ID: <code>${jobId}</code>`,
    );

    // Show post-submit export card
    els.jobExportCard.style.display = "block";
  } catch (err) {
    showStatus(
      els.jobStatus,
      "error",
      err.message || "Failed to submit job.",
    );
    const isNetworkError =
      !navigator.onLine || (err.message && err.message.includes("fetch"));
    showToast(
      "error",
      isNetworkError
        ? "Couldn't reach AlterLab"
        : "Job submission failed",
      err.message || "Failed to submit scrape job.",
      {
        actionLabel: "Retry",
        onAction: () => handleSubmitJob(),
      },
    );
  } finally {
    els.submitJobBtn.disabled = false;
    els.submitJobBtn.innerHTML = "Submit Scrape Job";
  }
}

async function handleCopyJob() {
  try {
    await navigator.clipboard.writeText(els.jobPreview.textContent);
  } catch (err) {
    // Fallback to execCommand
    try {
      const ta = document.createElement("textarea");
      ta.value = els.jobPreview.textContent;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (fallbackErr) {
      showToast("error", "Copy failed", "Could not copy job JSON to clipboard.");
      return;
    }
  }
  animateCopyButton(els.copyJobBtn);
}

// ---------------------------------------------------------------------------
// Account Tab
// ---------------------------------------------------------------------------

function bindAccountEvents() {
  if (els.connectBtn) {
    els.connectBtn.addEventListener("click", handleConnect);
  }
  if (els.disconnectBtn) {
    els.disconnectBtn.addEventListener("click", handleDisconnect);
  }
  if (els.apiKeyInput) {
    els.apiKeyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleConnect();
    });
  }

  // Login / signup buttons in account tab
  if (els.accountLoginBtn) {
    els.accountLoginBtn.addEventListener("click", () => {
      const apiUrl = els.apiUrlInput
        ? els.apiUrlInput.value.trim()
        : ALTERLAB_DEFAULT_API_URL;
      const baseUrl = normalizeUrl(apiUrl || ALTERLAB_DEFAULT_API_URL);

      // Show loading state
      const defaultLabel = els.accountLoginBtn.querySelector(".sp-auth-btn-default");
      const loadingLabel = els.accountLoginBtn.querySelector(".sp-auth-btn-loading");
      if (defaultLabel) defaultLabel.classList.add("hidden");
      if (loadingLabel) loadingLabel.classList.remove("hidden");
      els.accountLoginBtn.disabled = true;

      browser.tabs.create({
        url: `${baseUrl}/signin?source=extension`,
        active: true,
      });

      // Reset button state after a moment in case user returns to the panel
      setTimeout(() => {
        if (defaultLabel) defaultLabel.classList.remove("hidden");
        if (loadingLabel) loadingLabel.classList.add("hidden");
        els.accountLoginBtn.disabled = false;
      }, 8000);
    });
  }
  if (els.accountSignupLink) {
    els.accountSignupLink.addEventListener("click", (e) => {
      e.preventDefault();
      const apiUrl = els.apiUrlInput
        ? els.apiUrlInput.value.trim()
        : ALTERLAB_DEFAULT_API_URL;
      const baseUrl = normalizeUrl(apiUrl || ALTERLAB_DEFAULT_API_URL);
      browser.tabs.create({
        url: `${baseUrl}/register?source=extension`,
        active: true,
      });
    });
  }

  // API key panel toggle
  if (els.accountUseApiKeyBtn) {
    els.accountUseApiKeyBtn.addEventListener("click", () => {
      if (els.accountApiKeyPanel) {
        els.accountApiKeyPanel.classList.remove("hidden");
        els.accountUseApiKeyBtn.classList.add("hidden");
        if (els.apiKeyInput) els.apiKeyInput.focus();
      }
    });
  }
  if (els.accountHideApiKeyBtn) {
    els.accountHideApiKeyBtn.addEventListener("click", () => {
      if (els.accountApiKeyPanel) {
        els.accountApiKeyPanel.classList.add("hidden");
      }
      if (els.accountUseApiKeyBtn) {
        els.accountUseApiKeyBtn.classList.remove("hidden");
      }
    });
  }
}

function hideAllAccountViews() {
  if (els.accountAuthCheck) els.accountAuthCheck.classList.add("hidden");
  if (els.accountLogin) els.accountLogin.classList.add("hidden");
  if (els.accountSetup) els.accountSetup.classList.add("hidden");
  if (els.accountConnected) els.accountConnected.classList.add("hidden");
}

async function loadAccountState() {
  let authenticated = false;

  try {
    const config = await loadConfig();

    if (config.apiKey) {
      // Already have an API key — show connected view
      hideAllAccountViews();
      els.accountConnected.classList.remove("hidden");

      // Show instance URL
      try {
        const url = new URL(config.apiUrl);
        els.accountInstance.textContent = url.hostname;
      } catch {
        els.accountInstance.textContent = config.apiUrl;
      }

      // Fetch account info
      await fetchAccountInfo(config);
      authenticated = true;
    } else {
      // No API key — check if user is logged in to AlterLab
      hideAllAccountViews();
      if (els.accountAuthCheck) els.accountAuthCheck.classList.remove("hidden");

      try {
        const authResult = await browser.runtime.sendMessage({
          type: "CHECK_ALTERLAB_AUTH",
          apiUrl: config.apiUrl || ALTERLAB_DEFAULT_API_URL,
        });

        if (authResult && authResult.authenticated && authResult.hasApiKey && authResult.keys && authResult.keys.length > 0) {
          // Auto-configure with the first available API key (decrypt it)
          const selectedKey = authResult.keys[0];
          const apiUrl = config.apiUrl || ALTERLAB_DEFAULT_API_URL;
          const decryptResult = await browser.runtime.sendMessage({
            type: "DECRYPT_API_KEY",
            apiUrl,
            keyId: selectedKey.id,
          });

          if (decryptResult && decryptResult.key) {
            await saveConfig(decryptResult.key, apiUrl);
            browser.runtime.sendMessage({ type: "CONFIG_UPDATED" });

            // Refresh — now has API key
            hideAllAccountViews();
            els.accountConnected.classList.remove("hidden");

            try {
              const url = new URL(apiUrl);
              els.accountInstance.textContent = url.hostname;
            } catch {
              els.accountInstance.textContent = apiUrl;
            }

            await fetchAccountInfo({
              apiKey: decryptResult.key,
              apiUrl,
            });

            showToast("success", "Signed in", "API key auto-configured from your AlterLab session.", { duration: 3000 });
            authenticated = true;
          } else {
            // Decryption failed — show login prompt
            hideAllAccountViews();
            if (els.accountLogin) els.accountLogin.classList.remove("hidden");
            if (els.apiUrlInput) {
              els.apiUrlInput.value = config.apiUrl || ALTERLAB_DEFAULT_API_URL;
            }
          }
        } else {
          // Not logged in — show login prompt
          hideAllAccountViews();
          if (els.accountLogin) els.accountLogin.classList.remove("hidden");
          if (els.apiUrlInput) {
            els.apiUrlInput.value = config.apiUrl || ALTERLAB_DEFAULT_API_URL;
          }
        }
      } catch {
        // Auth check failed — show login prompt
        hideAllAccountViews();
        if (els.accountLogin) els.accountLogin.classList.remove("hidden");
        if (els.apiUrlInput) {
          els.apiUrlInput.value = config.apiUrl || ALTERLAB_DEFAULT_API_URL;
        }
      }
    }
  } catch {
    // Storage or runtime error — show login as safe fallback
    hideAllAccountViews();
    if (els.accountLogin) els.accountLogin.classList.remove("hidden");
  }

  // Refresh scrape tab usage pill when account state changes
  updateScrapeUsagePill();

  // Hide inline auth prompts if now authenticated
  if (authenticated) {
    if (els.captureAuthPrompt) els.captureAuthPrompt.classList.add("hidden");
    if (els.jobAuthPrompt) els.jobAuthPrompt.classList.add("hidden");
  }

  return authenticated;
}

async function fetchAccountInfo(config) {
  try {
    const resp = await fetch(`${config.apiUrl}/api/v1/auth/me`, {
      headers: { "X-API-Key": config.apiKey },
    });

    if (resp.ok) {
      const data = await resp.json();
      const credits = data.credits_remaining ?? data.credits ?? "N/A";
      els.accountCredits.textContent =
        typeof credits === "number" ? `$${credits.toFixed(2)}` : String(credits);

      // Credits bar (assume max $100 for visual)
      if (typeof credits === "number") {
        const pct = Math.min(100, (credits / 100) * 100);
        els.creditsBarFill.style.width = `${pct}%`;
      }
    }
  } catch (err) {
    els.accountCredits.textContent = "Unavailable";
    showToast(
      "warning",
      "Couldn't reach AlterLab",
      "Account info unavailable \u2014 working offline.",
      { duration: 4000 },
    );
  }

  // Fetch sessions
  try {
    const resp = await fetch(`${config.apiUrl}/api/v1/sessions`, {
      headers: { "X-API-Key": config.apiKey },
    });

    if (resp.ok) {
      const data = await resp.json();
      const count = data.total || (Array.isArray(data) ? data.length : 0);
      els.accountSessions.textContent = String(count);

      els.savedSessionsCard.style.display = "block";
      els.sessionCountBadge.textContent = String(count);

      if (count > 0) {
        const sessions = Array.isArray(data) ? data : data.sessions || [];
        els.savedSessionsList.innerHTML = "";
        for (const session of sessions.slice(0, 10)) {
          const div = document.createElement("div");
          div.style.cssText =
            "padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px;";
          div.innerHTML = `<strong>${session.name || session.domain || "Untitled"}</strong>
            <span style="color: var(--text-muted); font-size: 11px;">${session.domain || ""}</span>`;
          els.savedSessionsList.appendChild(div);
        }
      } else {
        renderEmptyState(els.savedSessionsList, {
          icon: EMPTY_ICONS.session,
          title: "No saved sessions",
          description: "Save your first session \u2014 capture cookies while logged in.",
        });
      }
    }
  } catch (err) {
    els.accountSessions.textContent = "Unavailable";
  }
}

async function handleConnect() {
  const apiKey = els.apiKeyInput.value.trim();
  const apiUrl =
    els.apiUrlInput.value.trim() || ALTERLAB_DEFAULT_API_URL;

  if (!apiKey) {
    showStatus(els.accountStatus, "error", "Please enter your API key.");
    return;
  }

  if (!apiKey.startsWith("sk_live_")) {
    showStatus(
      els.accountStatus,
      "error",
      'API key should start with "sk_live_".',
    );
    return;
  }

  els.connectBtn.disabled = true;
  els.connectBtn.innerHTML = '<span class="spinner"></span>';

  try {
    const resp = await fetch(`${normalizeUrl(apiUrl)}/api/v1/auth/me`, {
      headers: { "X-API-Key": apiKey },
    });

    if (!resp.ok) {
      throw new Error(`Invalid API key (HTTP ${resp.status})`);
    }

    await saveConfig(apiKey, normalizeUrl(apiUrl));
    browser.runtime.sendMessage({ type: "CONFIG_UPDATED" });

    await loadAccountState();
  } catch (err) {
    showStatus(
      els.accountStatus,
      "error",
      err.message || "Failed to connect.",
    );
    showToast(
      "error",
      "Connection failed",
      err.message || "Could not validate API key.",
    );
  } finally {
    els.connectBtn.disabled = false;
    els.connectBtn.textContent = "Connect";
  }
}

async function handleDisconnect() {
  await saveConfig("", ALTERLAB_DEFAULT_API_URL);
  browser.runtime.sendMessage({ type: "CONFIG_UPDATED" });
  els.savedSessionsCard.style.display = "none";
  await loadAccountState();
}

// ---------------------------------------------------------------------------
// Onboarding Carousel
// ---------------------------------------------------------------------------

let onboardingStep = 0;
const ONBOARDING_TOTAL_STEPS = 3;

async function maybeShowOnboarding() {
  const result = await browser.storage.local.get(["hasSeenOnboarding"]);

  if (result.hasSeenOnboarding) return;

  els.onboardingOverlay.classList.remove("hidden");
  onboardingStep = 0;
  updateOnboardingStep();
}

function updateOnboardingStep() {
  // Update step visibility
  const steps = els.onboardingOverlay.querySelectorAll(".onboarding-step");
  steps.forEach((step, i) => {
    step.classList.toggle("active", i === onboardingStep);
  });

  // Update dots
  const dots = els.onboardingDots.querySelectorAll(".onboarding-dot");
  dots.forEach((dot, i) => {
    dot.classList.toggle("active", i === onboardingStep);
  });

  // Update nav buttons
  els.onboardingBackBtn.disabled = onboardingStep === 0;

  if (onboardingStep === ONBOARDING_TOTAL_STEPS - 1) {
    els.onboardingNextBtn.textContent = "Get Started";
    els.onboardingNextBtn.classList.add("onboarding-nav-finish");
  } else {
    els.onboardingNextBtn.textContent = "Next";
    els.onboardingNextBtn.classList.remove("onboarding-nav-finish");
  }
}

function dismissOnboarding() {
  const overlay = els.onboardingOverlay;
  overlay.classList.add("dismissing");

  browser.storage.local.set({ hasSeenOnboarding: true });

  overlay.addEventListener(
    "animationend",
    () => {
      overlay.classList.add("hidden");
      overlay.classList.remove("dismissing");
    },
    { once: true },
  );
}

function showOnboarding() {
  if (!els.onboardingOverlay) return;

  browser.storage.local.remove("hasSeenOnboarding");
  onboardingStep = 0;
  updateOnboardingStep();

  els.onboardingOverlay.classList.remove("hidden", "dismissing");
}

function bindTourLinks() {
  const tourBtn = document.getElementById("takeTourBtn");
  const tourBtnLogin = document.getElementById("takeTourBtnLogin");

  if (tourBtn) {
    tourBtn.addEventListener("click", (e) => {
      e.preventDefault();
      showOnboarding();
    });
  }
  if (tourBtnLogin) {
    tourBtnLogin.addEventListener("click", (e) => {
      e.preventDefault();
      showOnboarding();
    });
  }
}

function bindOnboardingCarousel() {
  if (!els.onboardingOverlay) return;

  els.onboardingNextBtn.addEventListener("click", () => {
    if (onboardingStep < ONBOARDING_TOTAL_STEPS - 1) {
      onboardingStep++;
      updateOnboardingStep();
    } else {
      dismissOnboarding();
    }
  });

  els.onboardingBackBtn.addEventListener("click", () => {
    if (onboardingStep > 0) {
      onboardingStep--;
      updateOnboardingStep();
    }
  });

  // Dot navigation
  const dots = els.onboardingDots.querySelectorAll(".onboarding-dot");
  dots.forEach((dot) => {
    dot.addEventListener("click", () => {
      onboardingStep = parseInt(dot.dataset.dot, 10);
      updateOnboardingStep();
    });
  });

  // Click on backdrop (outside card) dismisses
  els.onboardingOverlay.addEventListener("click", (e) => {
    if (e.target === els.onboardingOverlay) {
      dismissOnboarding();
    }
  });
}

/**
 * Update onboarding score preview when analysis completes.
 * Called from renderInspectTab after the score is computed.
 */
function updateOnboardingScore(score) {
  if (els.onboardingScoreNum) {
    els.onboardingScoreNum.textContent = String(score);
    els.onboardingScoreNum.style.color = scrapeScoreColor(score);
  }
}

// ---------------------------------------------------------------------------
// Micro-interaction Helpers
// ---------------------------------------------------------------------------

/**
 * Animate a copy button that has .btn-icon-copy and .btn-icon-check SVGs.
 * Shows checkmark with pop animation, reverts after 2s.
 */
function animateCopyButton(btn) {
  if (!btn || btn.classList.contains("copied")) return;
  btn.classList.add("copied");
  btn.classList.add("al-copied");
  const label = btn.querySelector(".btn-label");
  if (label) label.textContent = "Copied!";

  // Inject temporary checkmark if no .al-copy-check exists
  let check = btn.querySelector(".al-copy-check");
  if (!check) {
    check = document.createElement("span");
    check.className = "al-copy-check";
    check.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--success, #22c55e)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    btn.appendChild(check);
  }

  setTimeout(() => {
    btn.classList.remove("copied");
    btn.classList.remove("al-copied");
    if (label) label.textContent = "Copy";
    // Remove injected checkmark
    const injected = btn.querySelector(".al-copy-check");
    if (injected && !btn.dataset.hasCheck) injected.remove();
  }, 2000);
}

/**
 * Animate a text-only copy button (no SVG icons — e.g., inspector export buttons).
 * Swaps text with a brief highlight, reverts after 1.5s.
 */
function animateCopyButtonText(btn) {
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = "Copied!";
  btn.style.color = "var(--success)";
  btn.style.borderColor = "var(--success)";
  setTimeout(() => {
    btn.textContent = orig;
    btn.style.color = "";
    btn.style.borderColor = "";
  }, 1500);
}

/**
 * Trigger a subtle scale bounce on a checkbox element.
 */
function bounceCheckbox(checkbox) {
  checkbox.classList.add("bounce");
  setTimeout(() => {
    checkbox.classList.remove("bounce");
  }, 200);
}

// ---------------------------------------------------------------------------
// Inline Auth Prompts
// ---------------------------------------------------------------------------

function bindInlineAuthPrompts() {
  // Capture tab inline auth
  els.captureAuthConnect.addEventListener("click", () => {
    handleInlineAuth(
      els.captureAuthKey,
      els.captureAuthStatus,
      els.captureAuthConnect,
      els.captureAuthPrompt,
      () => handleCapture(),
    );
  });
  els.captureAuthKey.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.captureAuthConnect.click();
  });

  // Job tab inline auth
  els.jobAuthConnect.addEventListener("click", () => {
    handleInlineAuth(
      els.jobAuthKey,
      els.jobAuthStatus,
      els.jobAuthConnect,
      els.jobAuthPrompt,
      () => handleSubmitJob(),
    );
  });
  els.jobAuthKey.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.jobAuthConnect.click();
  });
}

async function handleInlineAuth(
  keyInput,
  statusEl,
  connectBtn,
  promptEl,
  onSuccess,
) {
  const apiKey = keyInput.value.trim();

  if (!apiKey) {
    showStatus(statusEl, "error", "Please enter your API key.");
    return;
  }

  if (!apiKey.startsWith("sk_live_")) {
    showStatus(statusEl, "error", 'API key should start with "sk_live_".');
    return;
  }

  connectBtn.disabled = true;
  connectBtn.innerHTML = '<span class="spinner"></span>';

  try {
    const savedConfig = await loadConfig();
    const apiUrl = savedConfig.apiUrl || ALTERLAB_DEFAULT_API_URL;
    const resp = await fetch(`${apiUrl}/api/v1/auth/me`, {
      headers: { "X-API-Key": apiKey },
    });

    if (!resp.ok) {
      throw new Error(`Invalid API key (HTTP ${resp.status})`);
    }

    // Save config and update account state
    await saveConfig(apiKey, apiUrl);
    browser.runtime.sendMessage({ type: "CONFIG_UPDATED" });

    // Hide prompt and refresh account state
    promptEl.classList.add("hidden");
    await loadAccountState();

    // Execute the original action that triggered the auth prompt
    onSuccess();
  } catch (err) {
    showStatus(statusEl, "error", err.message || "Failed to connect.");
    showToast("error", "Authentication failed", err.message || "Could not validate API key.");
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent =
      connectBtn === els.captureAuthConnect
        ? "Connect & Capture"
        : "Connect & Submit";
  }
}

// ---------------------------------------------------------------------------
// Empty State Helper
// ---------------------------------------------------------------------------

/**
 * Render a contextual empty state using the .al-empty-* design system classes.
 * @param {HTMLElement} container — the element to render into (innerHTML is cleared)
 * @param {object} opts
 * @param {string} opts.icon — SVG markup string for the icon
 * @param {string} opts.title — main message
 * @param {string} opts.description — explanation text
 */
function renderEmptyState(container, { icon, title, description }) {
  container.innerHTML = "";
  const wrapper = document.createElement("div");
  wrapper.className = "al-empty";

  const iconEl = document.createElement("div");
  iconEl.className = "al-empty-icon";
  iconEl.innerHTML = icon;

  const titleEl = document.createElement("div");
  titleEl.className = "al-empty-title";
  titleEl.textContent = title;

  const descEl = document.createElement("div");
  descEl.className = "al-empty-description";
  descEl.textContent = description;

  wrapper.appendChild(iconEl);
  wrapper.appendChild(titleEl);
  wrapper.appendChild(descEl);
  container.appendChild(wrapper);
}

// SVG icons for empty states (24x24 viewBox, stroke-based)
const EMPTY_ICONS = {
  cookie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="8" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="10" cy="15" r="1" fill="currentColor"/><circle cx="14" cy="7" r="0.5" fill="currentColor"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
  api: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/><circle cx="20" cy="18" r="2"/></svg>',
  session: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
};

// ---------------------------------------------------------------------------
// Selector Builder Tab
// ---------------------------------------------------------------------------

let selNextId = 1;

function bindSelectorEvents() {
  els.selToggleBtn.addEventListener("click", () => {
    if (selActive) {
      deactivateSelectorBuilder();
    } else {
      activateSelectorBuilder();
    }
  });

  els.selClearAll.addEventListener("click", () => {
    selSelectors = [];
    renderSelectorList();
    clearAllTestHighlights();
    showToast("info", "Selectors cleared");
  });

  els.selCopyCurl.addEventListener("click", () => exportSelectors("curl"));
  els.selCopyPython.addEventListener("click", () => exportSelectors("python"));
  els.selCopyNode.addEventListener("click", () => exportSelectors("node"));
  els.selCopyJson.addEventListener("click", () => exportSelectors("json"));

  // Listen for messages from content script via background
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "SELECTOR_PICKED") {
      const entry = {
        id: selNextId++,
        css: message.css,
        xpath: message.xpath,
        reliability: message.reliability,
        reliabilityLabel: message.reliabilityLabel,
        tag: message.tag,
        classes: message.classes || [],
        text: message.text || "",
        dimensions: message.dimensions || {},
        fieldName: "",
      };
      selSelectors.push(entry);
      renderSelectorList();
      showToast("success", "Selector captured", `${entry.tag} element — ${entry.reliabilityLabel} reliability`);
    }

    if (message.type === "SELECTOR_ESCAPED") {
      deactivateSelectorBuilder();
    }

    // Auth state changed — background detected login via cookie listener
    if (message.type === "CONFIG_UPDATED") {
      loadAccountState().then(() => {
        showToast("success", "Signed in", "API key auto-configured from your AlterLab session.", { duration: 3000 });
        updateScrapeUsagePill();
      });
    }

    if (message.type === "AUTH_STATUS_CHANGED") {
      if (message.authenticated === false) {
        // User logged out — refresh account state (will show login prompt if config cleared)
        loadAccountState();
      } else if (message.configured) {
        // API key just set via dashboard handshake — reload to show connected state
        loadAccountState().then(() => {
          showToast("success", "Connected", "AlterLab API key received. Extension is ready.", { duration: 3000 });
          updateScrapeUsagePill();
        });
      } else if (message.authenticated && !message.hasApiKey) {
        // Logged in but no API keys — refresh to show appropriate state
        loadAccountState().then(() => {
          showToast("info", "Signed in", "No API keys found. Create one at alterlab.io/dashboard.", { duration: 5000 });
        });
      }
    }
  });
}

async function activateSelectorBuilder() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  try {
    await browser.tabs.sendMessage(tab.id, { type: "SELECTOR_ACTIVATE" });
    selActive = true;
    els.selToggleBtn.textContent = "Stop Picking";
    els.selToggleBtn.style.background = "var(--error)";
    els.selActiveIndicator.style.display = "block";
  } catch {
    showToast("error", "Cannot activate", "Content script not available on this page");
  }
}

async function deactivateSelectorBuilder() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    try {
      await browser.tabs.sendMessage(tab.id, { type: "SELECTOR_DEACTIVATE" });
    } catch { /* content script may be unavailable */ }
  }
  selActive = false;
  els.selToggleBtn.textContent = "Start Picking";
  els.selToggleBtn.style.background = "";
  els.selActiveIndicator.style.display = "none";
}

function renderSelectorList() {
  const count = selSelectors.length;
  els.selCountBadge.textContent = String(count);
  els.selExportCard.style.display = count > 0 ? "" : "none";

  if (count === 0) {
    els.selSelectorList.innerHTML = '<span style="color: var(--text-muted);">No selectors captured yet. Start picking to add elements.</span>';
    return;
  }

  els.selSelectorList.innerHTML = selSelectors.map((s) => {
    const relColor = s.reliability >= 85 ? "var(--success)" :
                     s.reliability >= 65 ? "var(--accent)" :
                     s.reliability >= 40 ? "var(--warning)" : "var(--error)";
    const relBg = s.reliability >= 85 ? "rgba(34,197,94,0.12)" :
                  s.reliability >= 65 ? "rgba(99,102,241,0.12)" :
                  s.reliability >= 40 ? "rgba(245,158,11,0.12)" : "rgba(239,68,68,0.12)";

    return `<div class="sel-item" data-sel-id="${s.id}">
      <div class="sel-item-header">
        <span class="sel-item-tag">&lt;${s.tag}&gt;</span>
        <span class="sel-item-badge" style="background:${relBg};color:${relColor};">${s.reliabilityLabel} (${s.reliability}%)</span>
        <button class="sel-item-remove" data-action="remove" title="Remove">&times;</button>
      </div>
      <div class="sel-selector-row">
        <span class="sel-selector-label">CSS</span>
        <span class="sel-selector-value" data-action="copy-css" title="Click to copy">${escapeHtml(s.css)}</span>
      </div>
      <div class="sel-selector-row">
        <span class="sel-selector-label">XPath</span>
        <span class="sel-selector-value" data-action="copy-xpath" title="Click to copy">${escapeHtml(s.xpath)}</span>
      </div>
      ${s.text ? `<div class="sel-text-preview">"${escapeHtml(s.text)}"</div>` : ""}
      <div class="sel-field-row">
        <input type="text" class="sel-field-input" data-action="field-name" placeholder="Field name (e.g. title, price, rating)" value="${escapeHtml(s.fieldName)}" />
      </div>
      <div class="sel-actions">
        <button data-action="test-css" title="Test CSS selector on page">Test CSS</button>
        <button data-action="test-xpath" title="Test XPath on page">Test XPath</button>
      </div>
      <div class="sel-test-result" data-ref="test-result"></div>
    </div>`;
  }).join("");

  // Bind click events via delegation
  els.selSelectorList.onclick = handleSelectorListClick;
  els.selSelectorList.oninput = handleSelectorListInput;
}

function handleSelectorListClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;

  const item = btn.closest(".sel-item");
  if (!item) return;
  const id = parseInt(item.dataset.selId);
  const entry = selSelectors.find((s) => s.id === id);
  if (!entry) return;

  const action = btn.dataset.action;

  if (action === "remove") {
    selSelectors = selSelectors.filter((s) => s.id !== id);
    renderSelectorList();
    clearAllTestHighlights();
    return;
  }

  if (action === "copy-css") {
    copyToClipboard(entry.css);
    showToast("success", "CSS selector copied");
    return;
  }

  if (action === "copy-xpath") {
    copyToClipboard(entry.xpath);
    showToast("success", "XPath copied");
    return;
  }

  if (action === "test-css" || action === "test-xpath") {
    const selectorType = action === "test-css" ? "css" : "xpath";
    const selector = selectorType === "css" ? entry.css : entry.xpath;
    testSelectorOnPage(selector, selectorType, item);
    return;
  }
}

function handleSelectorListInput(e) {
  const input = e.target.closest("[data-action='field-name']");
  if (!input) return;
  const item = input.closest(".sel-item");
  if (!item) return;
  const id = parseInt(item.dataset.selId);
  const entry = selSelectors.find((s) => s.id === id);
  if (entry) entry.fieldName = input.value;
}

async function testSelectorOnPage(selector, selectorType, itemEl) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  const resultEl = itemEl.querySelector("[data-ref='test-result']");

  try {
    const result = await browser.tabs.sendMessage(tab.id, {
      type: "SELECTOR_TEST",
      selector,
      selectorType,
    });

    resultEl.style.display = "block";
    if (result.error) {
      resultEl.style.background = "rgba(239,68,68,0.12)";
      resultEl.style.color = "var(--error)";
      resultEl.textContent = `Error: ${result.error}`;
    } else if (result.count === 0) {
      resultEl.style.background = "rgba(245,158,11,0.12)";
      resultEl.style.color = "var(--warning)";
      resultEl.textContent = "No matches found on current page";
    } else if (result.count === 1) {
      resultEl.style.background = "rgba(34,197,94,0.12)";
      resultEl.style.color = "var(--success)";
      resultEl.textContent = `1 match (unique) — highlighted on page`;
    } else {
      resultEl.style.background = "rgba(99,102,241,0.12)";
      resultEl.style.color = "var(--accent)";
      resultEl.textContent = `${result.count} matches — all highlighted on page`;
    }

    // Auto-hide after 5s
    setTimeout(() => { resultEl.style.display = "none"; }, 5000);
  } catch {
    resultEl.style.display = "block";
    resultEl.style.background = "rgba(239,68,68,0.12)";
    resultEl.style.color = "var(--error)";
    resultEl.textContent = "Content script unavailable";
  }
}

async function clearAllTestHighlights() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    try {
      await browser.tabs.sendMessage(tab.id, { type: "SELECTOR_CLEAR_HIGHLIGHTS" });
    } catch { /* ignore */ }
  }
}

function exportSelectors(format) {
  if (selSelectors.length === 0) return;

  const fields = selSelectors.map((s) => ({
    name: s.fieldName || s.tag,
    css: s.css,
    xpath: s.xpath,
    reliability: s.reliability,
  }));

  let output = "";

  if (format === "json") {
    output = JSON.stringify({ url: currentUrl, selectors: fields }, null, 2);
  } else if (format === "curl") {
    const selectorParam = fields.map(f => f.css).join(", ");
    output = `curl -X POST https://alterlab.io/api/v1/scrape \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({
    url: currentUrl,
    extract_rules: Object.fromEntries(fields.map(f => [f.name, { selector: f.css, type: "text" }])),
  })}'`;
  } else if (format === "python") {
    const rules = fields.map(f => `    "${f.name}": {"selector": "${f.css}", "type": "text"}`).join(",\n");
    output = `import requests

response = requests.post(
    "https://alterlab.io/api/v1/scrape",
    headers={
        "X-API-Key": "YOUR_API_KEY",
        "Content-Type": "application/json",
    },
    json={
        "url": "${currentUrl}",
        "extract_rules": {
${rules}
        },
    },
)

data = response.json()
print(data)`;
  } else if (format === "node") {
    const rules = fields.map(f => `    "${f.name}": { selector: "${f.css}", type: "text" }`).join(",\n");
    output = `const response = await fetch("https://alterlab.io/api/v1/scrape", {
  method: "POST",
  headers: {
    "X-API-Key": "YOUR_API_KEY",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    url: "${currentUrl}",
    extract_rules: {
${rules}
    },
  }),
});

const data = await response.json();
console.log(data);`;
  }

  copyToClipboard(output);
  const labels = { curl: "cURL", python: "Python", node: "Node.js", json: "JSON" };
  showToast("success", `Copied as ${labels[format]}`);
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {
    // Fallback for older browsers
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  });
}

// ---------------------------------------------------------------------------
// Listen for tab changes (re-analyze when user switches tabs)
// ---------------------------------------------------------------------------

browser.tabs.onActivated.addListener(async (activeInfo) => {
  // Deactivate selector builder when user switches browser tabs
  if (selActive) deactivateSelectorBuilder();

  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    if (tab && tab.url) {
      const url = new URL(tab.url);
      currentDomain = url.hostname;
      currentUrl = tab.url;
      els.domainPill.textContent = currentDomain;
      els.jobUrl.value = currentUrl;
      requestPageAnalysis(tab.id);
      loadCookies();
      loadInspectorCookies();
    }
  } catch (err) {
    // Tab URL parsing can fail for chrome:// and edge:// pages — not actionable
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) {
    try {
      const url = new URL(tab.url);
      currentDomain = url.hostname;
      currentUrl = tab.url;
      els.domainPill.textContent = currentDomain;
      els.jobUrl.value = currentUrl;
      requestPageAnalysis(tabId);
      loadCookies();
      loadInspectorCookies();
    } catch (err) {
      // Tab URL parsing can fail for chrome:// and edge:// pages — not actionable
    }
  }
});

// ---------------------------------------------------------------------------
// Robots Tab — robots.txt & Sitemap Viewer
// ---------------------------------------------------------------------------

/**
 * Parsed robots.txt state.
 * Structure: { raw, groups: { "user-agent": { allow: [], disallow: [], crawlDelay } }, sitemaps: [] }
 */
let rtParsed = null;
let rtSelectedBot = "*";
let rtSitemapUrls = []; // Flat list of all discovered URLs for export

const RT_WELL_KNOWN_BOTS = [
  "*",
  "Googlebot",
  "Bingbot",
  "GPTBot",
  "ClaudeBot",
  "ChatGPT-User",
  "CCBot",
  "Amazonbot",
  "Applebot",
  "Slurp",
  "DuckDuckBot",
  "Twitterbot",
  "facebookexternalhit",
];

function bindRobotsEvents() {
  els.rtFetchBtn.addEventListener("click", handleFetchRobots);
  els.rtCheckBtn.addEventListener("click", handleCrawlCheck);
  els.rtCopyRobots.addEventListener("click", handleCopyRobots);
  els.rtExportUrls.addEventListener("click", handleExportUrls);
  els.rtCrawlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleCrawlCheck();
  });
}

async function handleFetchRobots() {
  if (!currentDomain) return;

  els.rtFetchBtn.disabled = true;
  els.rtLoading.classList.remove("hidden");
  els.rtContent.classList.add("hidden");
  els.rtUpsell.classList.remove("visible");
  hideStatus(els.rtStatus);

  try {
    const robotsUrl = `https://${currentDomain}/robots.txt`;

    // Fetch via background service worker (CORS bypass)
    const result = await browser.runtime.sendMessage({
      type: "FETCH_URL",
      url: robotsUrl,
    });

    if (result.error) {
      if (result.status === 404) {
        showStatus(
          els.rtStatus,
          "error",
          "No robots.txt found (404). This site may not have one.",
        );
      } else {
        showStatus(els.rtStatus, "error", `Failed: ${result.error}`);
        els.rtUpsell.classList.add("visible");
      }
      return;
    }

    // Validate it looks like robots.txt (not an HTML error page)
    const body = result.body || "";
    if (
      body.trim().startsWith("<!") ||
      body.trim().startsWith("<html") ||
      body.trim().startsWith("<HTML")
    ) {
      showStatus(
        els.rtStatus,
        "error",
        "Received HTML instead of robots.txt. Site may redirect or block access.",
      );
      els.rtUpsell.classList.add("visible");
      return;
    }

    // Parse and render
    rtParsed = parseRobotsTxt(body);
    renderRobotsContent();
    els.rtContent.classList.remove("hidden");
  } catch (err) {
    showStatus(
      els.rtStatus,
      "error",
      err.message || "Failed to fetch robots.txt",
    );
    els.rtUpsell.classList.add("visible");
  } finally {
    els.rtFetchBtn.disabled = false;
    els.rtLoading.classList.add("hidden");
  }
}

/**
 * Parse robots.txt into structured data.
 * Returns { raw, groups, sitemaps, crawlDelays }.
 */
function parseRobotsTxt(raw) {
  const lines = raw.split("\n");
  const groups = {}; // keyed by lowercase user-agent
  const sitemaps = [];
  let currentAgents = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const directive = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();

    if (directive === "user-agent") {
      currentAgents = [value];
      for (const agent of currentAgents) {
        const key = agent.toLowerCase();
        if (!groups[key]) {
          groups[key] = {
            name: agent,
            allow: [],
            disallow: [],
            crawlDelay: null,
          };
        }
      }
    } else if (directive === "allow" && currentAgents.length > 0) {
      for (const agent of currentAgents) {
        groups[agent.toLowerCase()].allow.push(value);
      }
    } else if (directive === "disallow" && currentAgents.length > 0) {
      if (value) {
        // Empty Disallow means allow all — skip it
        for (const agent of currentAgents) {
          groups[agent.toLowerCase()].disallow.push(value);
        }
      }
    } else if (directive === "crawl-delay" && currentAgents.length > 0) {
      for (const agent of currentAgents) {
        groups[agent.toLowerCase()].crawlDelay = parseFloat(value) || null;
      }
    } else if (directive === "sitemap") {
      sitemaps.push(value);
    }
  }

  return { raw, groups, sitemaps };
}

function renderRobotsContent() {
  if (!rtParsed) return;

  // 1. Syntax-highlighted code block
  renderHighlightedRobotsTxt(rtParsed.raw);

  // 2. Bot chips
  renderBotList();

  // 3. Selected bot rules
  renderBotRules();

  // 4. Sitemaps
  renderSitemaps();
}

function renderHighlightedRobotsTxt(raw) {
  const lines = raw.split("\n");
  let html = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      html += '<span class="rt-line">\n</span>';
      continue;
    }
    if (trimmed.startsWith("#")) {
      html += `<span class="rt-line rt-line-comment">${escapeHtml(line)}</span>\n`;
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("user-agent:")) {
      html += `<span class="rt-line rt-line-useragent">${escapeHtml(line)}</span>\n`;
    } else if (lower.startsWith("allow:")) {
      html += `<span class="rt-line rt-line-allow">${escapeHtml(line)}</span>\n`;
    } else if (lower.startsWith("disallow:")) {
      html += `<span class="rt-line rt-line-disallow">${escapeHtml(line)}</span>\n`;
    } else if (lower.startsWith("sitemap:")) {
      html += `<span class="rt-line rt-line-sitemap">${escapeHtml(line)}</span>\n`;
    } else if (lower.startsWith("crawl-delay:")) {
      html += `<span class="rt-line rt-line-crawldelay">${escapeHtml(line)}</span>\n`;
    } else {
      html += `<span class="rt-line">${escapeHtml(line)}</span>\n`;
    }
  }
  els.rtCodeBlock.innerHTML = html;
}

function renderBotList() {
  els.rtBotList.innerHTML = "";
  const presentBots = new Set(Object.keys(rtParsed.groups));

  // Show well-known bots that are present in the robots.txt
  const botsToShow = [];
  for (const bot of RT_WELL_KNOWN_BOTS) {
    if (presentBots.has(bot.toLowerCase())) {
      botsToShow.push(bot);
    }
  }
  // Also add any bots in the file not in the well-known list
  for (const key of presentBots) {
    const found = botsToShow.some((b) => b.toLowerCase() === key);
    if (!found) {
      botsToShow.push(rtParsed.groups[key].name);
    }
  }

  for (const bot of botsToShow) {
    const chip = document.createElement("button");
    chip.className =
      "rt-bot-chip" +
      (bot.toLowerCase() === rtSelectedBot.toLowerCase() ? " active" : "");
    chip.textContent = bot;
    chip.addEventListener("click", () => {
      rtSelectedBot = bot;
      renderBotList();
      renderBotRules();
    });
    els.rtBotList.appendChild(chip);
  }
}

function renderBotRules() {
  els.rtBotRules.innerHTML = "";
  const group = rtParsed.groups[rtSelectedBot.toLowerCase()];
  if (!group) {
    els.rtBotRules.innerHTML =
      '<div style="font-size: 12px; color: var(--text-muted);">No specific rules for this bot.</div>';
    return;
  }

  // Crawl-delay info
  if (group.crawlDelay) {
    const delayEl = document.createElement("div");
    delayEl.style.cssText =
      "font-size: 12px; color: var(--warning); margin-bottom: 8px;";
    delayEl.textContent = `Crawl-Delay: ${group.crawlDelay}s`;
    els.rtBotRules.appendChild(delayEl);
  }

  // Rules
  const allRules = [
    ...group.allow.map((p) => ({ type: "allow", path: p })),
    ...group.disallow.map((p) => ({ type: "disallow", path: p })),
  ];

  // Sort: disallow first, then by path
  allRules.sort((a, b) => {
    if (a.type !== b.type) return a.type === "disallow" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  if (allRules.length === 0) {
    els.rtBotRules.innerHTML =
      '<div style="font-size: 12px; color: var(--text-muted);">No rules defined (everything allowed).</div>';
    return;
  }

  for (const rule of allRules) {
    const item = document.createElement("div");
    item.className = "rt-rule-item";

    const badge = document.createElement("span");
    badge.className = `rt-rule-badge ${rule.type}`;
    badge.textContent = rule.type === "allow" ? "Allow" : "Deny";

    const path = document.createElement("span");
    path.className = "rt-rule-path";
    path.textContent = rule.path;
    path.title = rule.path;

    item.appendChild(badge);
    item.appendChild(path);
    els.rtBotRules.appendChild(item);
  }
}

/**
 * Check if a given path is allowed or disallowed for the selected bot.
 * Implements standard robots.txt matching: longer path wins, Allow wins ties.
 */
function handleCrawlCheck() {
  const path = els.rtCrawlInput.value.trim();
  if (!path || !rtParsed) return;

  // Ensure path starts with /
  const checkPath = path.startsWith("/") ? path : "/" + path;

  // Get rules for selected bot, plus wildcard fallback
  const botGroup = rtParsed.groups[rtSelectedBot.toLowerCase()];
  const wildcardGroup = rtParsed.groups["*"];

  // Merge rules: specific bot overrides wildcard
  const group = botGroup || wildcardGroup;

  if (!group) {
    // No rules at all — allowed
    showCrawlResult(true, checkPath, "No rules found — crawling is allowed.");
    return;
  }

  // Find the best matching rule (longest prefix match)
  let bestMatch = null;
  let bestLen = -1;

  const allRules = [
    ...group.allow.map((p) => ({ type: "allow", path: p })),
    ...group.disallow.map((p) => ({ type: "disallow", path: p })),
  ];

  for (const rule of allRules) {
    if (matchRobotsPattern(rule.path, checkPath)) {
      const len = rule.path.replace(/\*/g, "").length;
      if (len > bestLen || (len === bestLen && rule.type === "allow")) {
        bestLen = len;
        bestMatch = rule;
      }
    }
  }

  if (!bestMatch || bestMatch.type === "allow") {
    showCrawlResult(
      true,
      checkPath,
      bestMatch
        ? `Allowed by rule: ${bestMatch.path}`
        : "No matching rules — crawling is allowed.",
    );
  } else {
    showCrawlResult(
      false,
      checkPath,
      `Disallowed by rule: ${bestMatch.path}`,
    );
  }
}

/**
 * Match a robots.txt pattern against a path.
 * Supports * (wildcard) and $ (end anchor).
 */
function matchRobotsPattern(pattern, path) {
  // Convert robots pattern to regex
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      regex += ".*";
    } else if (ch === "$" && i === pattern.length - 1) {
      regex += "$";
    } else {
      regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  // If no end anchor, match as prefix
  if (!pattern.endsWith("$")) {
    // pattern is a prefix match
  }
  try {
    return new RegExp(regex).test(path);
  } catch {
    // Fallback to simple prefix match
    return path.startsWith(pattern.replace(/\*/g, "").replace(/\$/g, ""));
  }
}

function showCrawlResult(allowed, path, reason) {
  const el = els.rtCrawlResult;
  el.className = `rt-crawl-result visible ${allowed ? "allowed" : "disallowed"}`;
  el.textContent = `${allowed ? "ALLOWED" : "BLOCKED"}: ${path} — ${reason}`;
}

function renderSitemaps() {
  els.rtSitemapContainer.innerHTML = "";
  rtSitemapUrls = [];

  if (rtParsed.sitemaps.length === 0) {
    els.rtSitemapContainer.innerHTML =
      '<div style="font-size: 12px; color: var(--text-muted);">No sitemaps found in robots.txt</div>';
    els.rtExportUrls.disabled = true;
    els.rtSitemapTree.classList.add("hidden");
    return;
  }

  els.rtSitemapTree.classList.remove("hidden");
  els.rtSitemapTree.innerHTML = "";

  for (const sitemapUrl of rtParsed.sitemaps) {
    const node = createSitemapNode(sitemapUrl, 0);
    els.rtSitemapTree.appendChild(node);
  }

  els.rtSitemapContainer.innerHTML = `<div style="font-size: 12px; color: var(--text-muted);">${rtParsed.sitemaps.length} sitemap${rtParsed.sitemaps.length !== 1 ? "s" : ""} discovered</div>`;
}

function createSitemapNode(url, depth) {
  const node = document.createElement("div");
  node.className = "rt-sitemap-node";

  const header = document.createElement("div");
  header.className = "rt-sitemap-header";
  header.style.paddingLeft = `${10 + depth * 16}px`;

  const expandSvg = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  );
  expandSvg.setAttribute("viewBox", "0 0 24 24");
  expandSvg.setAttribute("fill", "none");
  expandSvg.setAttribute("stroke", "currentColor");
  expandSvg.setAttribute("stroke-width", "2");
  expandSvg.setAttribute("stroke-linecap", "round");
  expandSvg.setAttribute("stroke-linejoin", "round");
  expandSvg.classList.add("rt-sitemap-expand");
  const polyline = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "polyline",
  );
  polyline.setAttribute("points", "9 18 15 12 9 6");
  expandSvg.appendChild(polyline);

  const urlSpan = document.createElement("span");
  urlSpan.className = "rt-sitemap-url";
  // Show just the path portion for readability
  try {
    const parsed = new URL(url);
    urlSpan.textContent = parsed.pathname + parsed.search;
  } catch {
    urlSpan.textContent = url;
  }
  urlSpan.title = url;

  const badge = document.createElement("span");
  badge.className = "rt-sitemap-badge";
  badge.textContent = "Click to load";

  header.appendChild(expandSvg);
  header.appendChild(urlSpan);
  header.appendChild(badge);

  const children = document.createElement("div");
  children.className = "rt-sitemap-children";

  node.appendChild(header);
  node.appendChild(children);

  let loaded = false;

  header.addEventListener("click", async () => {
    if (node.classList.contains("expanded")) {
      node.classList.remove("expanded");
      return;
    }

    node.classList.add("expanded");

    if (!loaded) {
      loaded = true;
      badge.textContent = "Loading...";
      try {
        const result = await browser.runtime.sendMessage({
          type: "FETCH_URL",
          url: url,
        });

        if (result.error) {
          badge.textContent = "Error";
          children.innerHTML = `<div class="rt-url-item" style="color: var(--error);">${escapeHtml(result.error)}</div>`;
          return;
        }

        const parsed = parseSitemap(result.body);
        badge.textContent = parsed.type;

        if (parsed.type === "index") {
          // Sitemap index — create child nodes
          for (const childUrl of parsed.urls) {
            const childNode = createSitemapNode(childUrl, depth + 1);
            children.appendChild(childNode);
          }
          badge.textContent = `Index (${parsed.urls.length})`;
        } else {
          // URL set — show URLs
          const maxShow = 200;
          const urls = parsed.urls;
          rtSitemapUrls.push(...urls);
          els.rtExportUrls.disabled = false;

          for (let i = 0; i < Math.min(urls.length, maxShow); i++) {
            const item = document.createElement("div");
            item.className = "rt-url-item";
            item.textContent = urls[i];
            item.title = urls[i];
            children.appendChild(item);
          }
          if (urls.length > maxShow) {
            const more = document.createElement("div");
            more.className = "rt-url-item";
            more.style.color = "var(--accent)";
            more.textContent = `... and ${urls.length - maxShow} more URLs`;
            children.appendChild(more);
          }
          badge.textContent = `${urls.length} URLs`;
        }
      } catch (err) {
        badge.textContent = "Error";
        children.innerHTML = `<div class="rt-url-item" style="color: var(--error);">${escapeHtml(err.message)}</div>`;
      }
    }
  });

  return node;
}

/**
 * Parse a sitemap XML document.
 * Returns { type: "index" | "urlset", urls: string[] }
 */
function parseSitemap(xml) {
  const urls = [];

  // Detect sitemap index vs URL set
  const isIndex =
    xml.includes("<sitemapindex") || xml.includes("<sitemap>");

  if (isIndex) {
    // Extract <loc> from <sitemap> elements
    const locRegex = /<sitemap[^>]*>[\s\S]*?<loc>\s*(.*?)\s*<\/loc>/gi;
    let match;
    while ((match = locRegex.exec(xml)) !== null) {
      urls.push(match[1].trim());
    }
    return { type: "index", urls };
  }

  // URL set — extract <loc> from <url> elements
  const locRegex = /<url[^>]*>[\s\S]*?<loc>\s*(.*?)\s*<\/loc>/gi;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    urls.push(match[1].trim());
  }

  // Fallback: just find all <loc> tags
  if (urls.length === 0) {
    const fallbackRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
    while ((match = fallbackRegex.exec(xml)) !== null) {
      urls.push(match[1].trim());
    }
  }

  return { type: "urlset", urls };
}

function handleCopyRobots() {
  if (!rtParsed) return;
  navigator.clipboard.writeText(rtParsed.raw).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = rtParsed.raw;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  });
  const orig = els.rtCopyRobots.textContent;
  els.rtCopyRobots.textContent = "Copied!";
  setTimeout(() => {
    els.rtCopyRobots.textContent = orig;
  }, 1500);
}

function handleExportUrls() {
  if (rtSitemapUrls.length === 0) return;
  const text = rtSitemapUrls.join("\n");
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  });
  const orig = els.rtExportUrls.textContent;
  els.rtExportUrls.textContent = `Copied ${rtSitemapUrls.length} URLs!`;
  setTimeout(() => {
    els.rtExportUrls.textContent = orig;
  }, 2000);
}

// ---------------------------------------------------------------------------
// Offline Detection
// ---------------------------------------------------------------------------

function bindOfflineDetection() {
  // Check initial state
  updateOfflineState();

  window.addEventListener("online", () => {
    updateOfflineState();
    showToast("success", "Back online", "Connection restored.", {
      duration: 3000,
    });
  });

  window.addEventListener("offline", () => {
    updateOfflineState();
  });
}

function updateOfflineState() {
  if (els.offlineBanner) {
    if (navigator.onLine) {
      els.offlineBanner.classList.add("hidden");
    } else {
      els.offlineBanner.classList.remove("hidden");
    }
  }
}
