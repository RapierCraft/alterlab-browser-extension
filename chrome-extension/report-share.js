/**
 * Share-report helpers (#38805): sanitise what leaves the browser and describe
 * it to the user so they can confirm before a public report is created.
 * Loaded before sidepanel.js; exposes window.AlterLabReportShare.
 */
(function (root) {
  "use strict";

  const RETENTION_DAYS = 30;

  /** http(s) URL without credentials, query string or fragment; null if invalid. */
  function sanitizeShareUrl(raw) {
    try {
      const u = new URL(String(raw));
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return null;
    }
  }

  /** Build the exact payload that will be POSTed, with sanitised URLs. */
  function buildReportPayload(analysis, ctx) {
    const signals = analysis.signals || [];
    const endpoints = [];
    for (const e of analysis.apiEndpoints || []) {
      const clean = sanitizeShareUrl(e);
      if (clean && !endpoints.includes(clean)) endpoints.push(clean);
    }
    return {
      domain: ctx.domain,
      url: sanitizeShareUrl(ctx.url) || `https://${ctx.domain}/`,
      title: analysis.title || ctx.domain,
      score: analysis.score,
      signals,
      anti_bot_stack: analysis.antiBotStack || analysis.antiBot || [],
      tech_stack: analysis.techStack || null,
      pagination: analysis.pagination || null,
      api_endpoints: endpoints,
      meta: analysis.meta || null,
      cookie_count: 0,
      has_login_wall: signals.some((s) => /login\s*wall/i.test(s)),
      has_cookie_gate: signals.some((s) => /cookie\s*(consent|gate)/i.test(s)),
      estimated_credits: ctx.credits,
    };
  }

  /** Human-readable lines describing what the report will contain. */
  function describeSharedData(payload) {
    return [
      `Page address (no query string or fragment): ${payload.url}`,
      `Page title: ${payload.title}`,
      `Scrapability score, detected signals and anti-bot / technology names`,
      `${payload.api_endpoints.length} API endpoint address(es) (query strings removed)`,
      `Number of cookies (never their values) and a cost estimate`,
      `Your IP address is not stored. The report is public to anyone with its link and is deleted after ${RETENTION_DAYS} days.`,
    ];
  }

  root.AlterLabReportShare = { sanitizeShareUrl, buildReportPayload, describeSharedData, RETENTION_DAYS };
})(typeof window !== "undefined" ? window : globalThis);
