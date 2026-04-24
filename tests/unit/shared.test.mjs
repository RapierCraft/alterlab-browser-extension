/**
 * AlterLab Connect — Unit Tests for shared.js
 *
 * Tests pure utility functions that can run in a Node.js environment without
 * browser APIs. Functions requiring browser.storage, DOM manipulation, or
 * chrome/browser globals are excluded (covered by Playwright e2e tests).
 *
 * Run: npm run test:unit
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Helpers — extract pure functions from shared.js for testing
//
// shared.js is a browser script (sourceType: script) that declares globals.
// We re-implement testable pure functions here rather than importing the file
// (which would require mocking browser, document, etc.). The implementations
// are exact copies of the source — any divergence is a test maintenance bug.
// ---------------------------------------------------------------------------

// AUTH_COOKIE_PATTERNS — copied from shared.js
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

function isAuthCookie(name) {
  return AUTH_COOKIE_PATTERNS.some((pattern) => pattern.test(name));
}

function cookieKey(cookie) {
  return `${cookie.name}|${cookie.domain}|${cookie.path}`;
}

function normalizeUrl(url) {
  url = url.replace(/\/+$/, "");
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  return url;
}

function getBaseDomain(hostname) {
  const parts = hostname.split(".");
  const twoPartTlds = [
    "co.uk", "co.jp", "co.kr", "co.in", "co.za",
    "com.au", "com.br", "com.cn", "com.mx", "com.tr",
    "org.uk", "net.au", "ac.uk",
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

function scoreToTier(score) {
  if (score == null || score <= 30) return 1;
  if (score <= 60) return 2;
  if (score <= 80) return 3;
  return 4;
}

function scrapeScoreLabel(score) {
  if (score <= 20) return "Very Easy";
  if (score <= 40) return "Easy";
  if (score <= 60) return "Moderate";
  if (score <= 80) return "Hard";
  return "Very Hard";
}

function estimateCredits(score) {
  const tier = scoreToTier(score);
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

function sameSiteLabel(sameSite) {
  if (!sameSite || sameSite === "no_restriction") return "None";
  if (sameSite === "unspecified") return "Unspecified";
  return sameSite.charAt(0).toUpperCase() + sameSite.slice(1).toLowerCase();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isNetworkError(err) {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("network error") ||
    msg.includes("networkerror") ||
    msg.includes("load failed") ||
    msg.includes("err_internet_disconnected") ||
    msg.includes("err_name_not_resolved") ||
    err.name === "TypeError"
  );
}

// ---------------------------------------------------------------------------
// Tests: isAuthCookie
// ---------------------------------------------------------------------------

describe("isAuthCookie", () => {
  it("detects common session cookie names", () => {
    expect(isAuthCookie("session")).toBe(true);
    expect(isAuthCookie("sessionid")).toBe(true);
    expect(isAuthCookie("PHPSESSID")).toBe(true);
    expect(isAuthCookie("ASP.NET_SessionId")).toBe(true);
    expect(isAuthCookie("JSESSIONID")).toBe(true);
    expect(isAuthCookie("connect.sid")).toBe(true);
  });

  it("detects token cookie names", () => {
    expect(isAuthCookie("token")).toBe(true);
    expect(isAuthCookie("access_token")).toBe(true);
    expect(isAuthCookie("refresh_token")).toBe(true);
    expect(isAuthCookie("jwt")).toBe(true);
    expect(isAuthCookie("JWT")).toBe(true);
  });

  it("detects auth prefixed cookies", () => {
    expect(isAuthCookie("auth")).toBe(true);
    expect(isAuthCookie("authToken")).toBe(true);
    expect(isAuthCookie("auth_session")).toBe(true);
  });

  it("detects CSRF cookies", () => {
    expect(isAuthCookie("csrf")).toBe(true);
    expect(isAuthCookie("_csrf")).toBe(true);
    expect(isAuthCookie("csrftoken")).toBe(true);
    expect(isAuthCookie("xsrf-token")).toBe(true);
    expect(isAuthCookie("XSRF-TOKEN")).toBe(true);
  });

  it("detects Cloudflare cookies", () => {
    expect(isAuthCookie("__cf_bm")).toBe(true);
    expect(isAuthCookie("cf_clearance")).toBe(true);
  });

  it("detects WordPress auth cookies", () => {
    expect(isAuthCookie("wordpress_logged_in_abc123")).toBe(true);
  });

  it("detects __Secure- and __Host- prefixed cookies", () => {
    expect(isAuthCookie("__Secure-session")).toBe(true);
    expect(isAuthCookie("__Host-token")).toBe(true);
  });

  it("detects li_at (LinkedIn auth)", () => {
    expect(isAuthCookie("li_at")).toBe(true);
  });

  it("rejects non-auth cookie names", () => {
    expect(isAuthCookie("_ga")).toBe(false);
    expect(isAuthCookie("_gid")).toBe(false);
    expect(isAuthCookie("preferences")).toBe(false);
    expect(isAuthCookie("theme")).toBe(false);
    expect(isAuthCookie("lang")).toBe(false);
    expect(isAuthCookie("currency")).toBe(false);
    expect(isAuthCookie("cookieconsent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: cookieKey
// ---------------------------------------------------------------------------

describe("cookieKey", () => {
  it("produces name|domain|path key", () => {
    expect(cookieKey({ name: "session", domain: "example.com", path: "/" }))
      .toBe("session|example.com|/");
  });

  it("distinguishes cookies with same name on different domains", () => {
    const a = cookieKey({ name: "auth", domain: "foo.com", path: "/" });
    const b = cookieKey({ name: "auth", domain: "bar.com", path: "/" });
    expect(a).not.toBe(b);
  });

  it("distinguishes cookies with same name on different paths", () => {
    const a = cookieKey({ name: "auth", domain: "foo.com", path: "/" });
    const b = cookieKey({ name: "auth", domain: "foo.com", path: "/admin" });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Tests: normalizeUrl
// ---------------------------------------------------------------------------

describe("normalizeUrl", () => {
  it("adds https:// when protocol is missing", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
  });

  it("strips trailing slash", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeUrl("https://example.com///")).toBe("https://example.com");
  });

  it("preserves https:// URLs", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });

  it("preserves http:// URLs", () => {
    expect(normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("preserves paths", () => {
    expect(normalizeUrl("https://example.com/api/v1")).toBe("https://example.com/api/v1");
  });
});

// ---------------------------------------------------------------------------
// Tests: getBaseDomain
// ---------------------------------------------------------------------------

describe("getBaseDomain", () => {
  it("extracts base domain from simple subdomain", () => {
    expect(getBaseDomain("www.amazon.com")).toBe("amazon.com");
  });

  it("handles two-part TLDs (co.uk)", () => {
    expect(getBaseDomain("smile.amazon.co.uk")).toBe("amazon.co.uk");
    expect(getBaseDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
  });

  it("handles two-part TLDs (com.au)", () => {
    expect(getBaseDomain("www.example.com.au")).toBe("example.com.au");
  });

  it("handles bare domain (no subdomain)", () => {
    expect(getBaseDomain("example.com")).toBe("example.com");
  });

  it("handles single-label hostname (localhost)", () => {
    expect(getBaseDomain("localhost")).toBe("localhost");
  });

  it("handles deep subdomains", () => {
    expect(getBaseDomain("a.b.c.example.com")).toBe("example.com");
  });
});

// ---------------------------------------------------------------------------
// Tests: scoreToTier
// ---------------------------------------------------------------------------

describe("scoreToTier", () => {
  it("maps null/undefined to tier 1", () => {
    expect(scoreToTier(null)).toBe(1);
    expect(scoreToTier(undefined)).toBe(1);
  });

  it("maps score 0 to tier 1", () => {
    expect(scoreToTier(0)).toBe(1);
  });

  it("maps score <= 30 to tier 1", () => {
    expect(scoreToTier(1)).toBe(1);
    expect(scoreToTier(30)).toBe(1);
  });

  it("maps score 31-60 to tier 2", () => {
    expect(scoreToTier(31)).toBe(2);
    expect(scoreToTier(60)).toBe(2);
  });

  it("maps score 61-80 to tier 3", () => {
    expect(scoreToTier(61)).toBe(3);
    expect(scoreToTier(80)).toBe(3);
  });

  it("maps score > 80 to tier 4", () => {
    expect(scoreToTier(81)).toBe(4);
    expect(scoreToTier(100)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Tests: scrapeScoreLabel
// ---------------------------------------------------------------------------

describe("scrapeScoreLabel", () => {
  it("returns Very Easy for score <= 20", () => {
    expect(scrapeScoreLabel(0)).toBe("Very Easy");
    expect(scrapeScoreLabel(20)).toBe("Very Easy");
  });

  it("returns Easy for score 21-40", () => {
    expect(scrapeScoreLabel(21)).toBe("Easy");
    expect(scrapeScoreLabel(40)).toBe("Easy");
  });

  it("returns Moderate for score 41-60", () => {
    expect(scrapeScoreLabel(41)).toBe("Moderate");
    expect(scrapeScoreLabel(60)).toBe("Moderate");
  });

  it("returns Hard for score 61-80", () => {
    expect(scrapeScoreLabel(61)).toBe("Hard");
    expect(scrapeScoreLabel(80)).toBe("Hard");
  });

  it("returns Very Hard for score > 80", () => {
    expect(scrapeScoreLabel(81)).toBe("Very Hard");
    expect(scrapeScoreLabel(100)).toBe("Very Hard");
  });
});

// ---------------------------------------------------------------------------
// Tests: estimateCredits
// ---------------------------------------------------------------------------

describe("estimateCredits", () => {
  it("returns tier 1 pricing for low score", () => {
    const result = estimateCredits(10);
    expect(result.tier).toBe(1);
    expect(result.costPerPage).toBe(0.0002);
    expect(result.scales["1K"].cost).toBe("0.20");
    expect(result.scales["100K"].cost).toBe("20.00");
    expect(result.scales["1M"].cost).toBe("200.00");
  });

  it("returns tier 4 pricing for high score", () => {
    const result = estimateCredits(90);
    expect(result.tier).toBe(4);
    expect(result.costPerPage).toBe(0.004);
    expect(result.scales["1K"].cost).toBe("4.00");
  });

  it("returns correct scale costs for tier 2", () => {
    const result = estimateCredits(50);
    expect(result.tier).toBe(2);
    expect(result.costPerPage).toBe(0.0003);
    expect(result.scales["1K"].cost).toBe("0.30");
    expect(result.scales["100K"].cost).toBe("30.00");
  });
});

// ---------------------------------------------------------------------------
// Tests: sameSiteLabel
// ---------------------------------------------------------------------------

describe("sameSiteLabel", () => {
  it("maps no_restriction to None", () => {
    expect(sameSiteLabel("no_restriction")).toBe("None");
  });

  it("maps null/empty to None", () => {
    expect(sameSiteLabel(null)).toBe("None");
    expect(sameSiteLabel("")).toBe("None");
    expect(sameSiteLabel(undefined)).toBe("None");
  });

  it("maps unspecified to Unspecified", () => {
    expect(sameSiteLabel("unspecified")).toBe("Unspecified");
  });

  it("capitalizes lax and strict", () => {
    expect(sameSiteLabel("lax")).toBe("Lax");
    expect(sameSiteLabel("strict")).toBe("Strict");
  });
});

// ---------------------------------------------------------------------------
// Tests: formatBytes
// ---------------------------------------------------------------------------

describe("formatBytes", () => {
  it("formats bytes under 1KB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });
});

// ---------------------------------------------------------------------------
// Tests: isNetworkError
// ---------------------------------------------------------------------------

describe("isNetworkError", () => {
  it("returns true for TypeError (fetch failures)", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("detects 'failed to fetch' message", () => {
    const err = new Error("Failed to fetch");
    expect(isNetworkError(err)).toBe(true);
  });

  it("detects 'network error' message", () => {
    expect(isNetworkError(new Error("Network error occurred"))).toBe(true);
  });

  it("returns false for non-network errors", () => {
    expect(isNetworkError(new Error("401 Unauthorized"))).toBe(false);
    expect(isNetworkError(new Error("Not Found"))).toBe(false);
    expect(isNetworkError(new RangeError("Out of range"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isNetworkError("network error string")).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});
