/**
 * AlterLab Connect - "Get API for this page".
 *
 * One click on the active tab's URL returns typed JSON plus ready-to-run
 * snippets (curl, Python, Node, MCP), and can publish the result as a public
 * data page or schedule it. Uses the user's API key or the keyless agent
 * trial. No page access beyond the URL of the active tab is needed.
 * Publishing is refused client-side for login-required or PII results; the
 * server enforces the same rules (public_pages.check_publishable).
 */
(function (root) {
  "use strict";

  const DEFAULT_API_URL = "https://alterlab.io";
  const MCP_URL = "https://mcp.alterlab.io/mcp";
  const PII_KEY = /(^|_)(email|e_mail|phone|ssn|password|passport|dob|birth_?date)(_|$)/i;
  const LOGIN_TEXT = /(sign|log)[\s-]?in to (continue|view)|please (sign|log)[\s-]?in|login required|type=["']?password/i;

  const REFUSAL_MESSAGES = {
    authenticated_result: "Login-required or session results cannot be published.",
    pii_flagged: "Results containing personal data (PII) cannot be published.",
    page_cap_reached: "You have reached the public page limit for your account.",
    already_published: "This result already has a public page.",
  };

  function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function buildSnippets(url, apiKey, apiUrl) {
    const base = (apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
    const key = apiKey || "YOUR_API_KEY";
    const body = JSON.stringify({ url, formats: ["json"] });
    return {
      curl: [
        `curl -X POST ${base}/api/v1/scrape \\`,
        `  -H "X-API-Key: ${key}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d ${shellQuote(body)}`,
      ].join("\n"),
      python: [
        "import requests",
        "",
        `r = requests.post("${base}/api/v1/scrape",`,
        `                  headers={"X-API-Key": "${key}"},`,
        `                  json={"url": ${JSON.stringify(url)}, "formats": ["json"]})`,
        "print(r.json())",
      ].join("\n"),
      node: [
        `const r = await fetch("${base}/api/v1/scrape", {`,
        `  method: "POST",`,
        `  headers: { "X-API-Key": "${key}", "Content-Type": "application/json" },`,
        `  body: JSON.stringify({ url: ${JSON.stringify(url)}, formats: ["json"] }),`,
        `});`,
        `console.log(await r.json());`,
      ].join("\n"),
      mcp: JSON.stringify(
        { mcpServers: { alterlab: { url: MCP_URL } }, _try: `scrape ${url} as json` },
        null,
        2,
      ),
    };
  }

  function hasPiiKey(value, depth) {
    if (!value || typeof value !== "object" || depth > 6) return false;
    if (Array.isArray(value)) return value.some((v) => hasPiiKey(v, depth + 1));
    return Object.keys(value).some((k) => PII_KEY.test(k) || hasPiiKey(value[k], depth + 1));
  }

  /** Returns {ok:true} or {ok:false, code, message}. */
  function publishPrecheck(run) {
    const r = run || {};
    const text = typeof r.content === "string" ? r.content : JSON.stringify(r.content || "");
    if (r.authenticated || r.usedSession || r.statusCode === 401 || r.statusCode === 403 || LOGIN_TEXT.test(text)) {
      return { ok: false, code: "authenticated_result", message: REFUSAL_MESSAGES.authenticated_result };
    }
    if (r.pii || r.piiDetected || hasPiiKey(r.content, 0)) {
      return { ok: false, code: "pii_flagged", message: REFUSAL_MESSAGES.pii_flagged };
    }
    return { ok: true };
  }

  async function readError(resp) {
    const b = await resp.json().catch(() => ({}));
    const d = b.detail;
    if (d && typeof d === "object" && d.code) {
      return { code: d.code, message: REFUSAL_MESSAGES[d.code] || d.message || d.code };
    }
    return { code: "http_" + resp.status, message: (typeof d === "string" && d) || `HTTP ${resp.status}` };
  }

  async function ensureKey(fetchFn, apiKey, base) {
    if (apiKey) return { key: apiKey, trial: false };
    const resp = await fetchFn(`${base}/api/v1/agent/trial`, { method: "POST" });
    if (!resp.ok) throw Object.assign(new Error("Could not start a free trial"), await readError(resp));
    const t = await resp.json();
    return { key: t.key, trial: true };
  }

  function post(fetchFn, base, path, key, body) {
    return fetchFn(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify(body),
    });
  }

  async function runGetApi(fetchFn, { url, apiKey, apiUrl }) {
    const base = (apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
    try {
      const { key, trial } = await ensureKey(fetchFn, apiKey, base);
      const resp = await post(fetchFn, base, "/api/v1/scrape", key, { url, formats: ["json"] });
      if (!resp.ok) return { error: await readError(resp) };
      const res = await resp.json();
      const run = {
        jobId: res.job_id || res.id || null,
        content: res.content !== undefined ? res.content : res.data || null,
        statusCode: res.status_code,
        authenticated: !!res.authenticated,
        pii: !!res.pii_detected,
      };
      // A trial key is returned once and is the only way to publish/schedule later.
      return {
        error: null,
        ...run,
        snippets: buildSnippets(url, key, base),
        apiKey: trial ? key : apiKey,
        trial,
        publish: publishPrecheck(run),
      };
    } catch (err) {
      return { error: { code: err.code || "network", message: err.message || "Network error" } };
    }
  }

  async function publishPage(fetchFn, { apiKey, apiUrl, run, title }) {
    const pre = publishPrecheck(run);
    if (!pre.ok) return { error: pre };
    if (!run || !run.jobId) return { error: { code: "no_job", message: "No stored result to publish." } };
    const base = (apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
    try {
      const resp = await post(fetchFn, base, "/api/v1/public-pages", apiKey, {
        source_type: "scrape",
        source_id: run.jobId,
        title: (title || "Page data").slice(0, 120),
      });
      if (!resp.ok) return { error: await readError(resp) };
      return { error: null, page: await resp.json() };
    } catch (err) {
      return { error: { code: "network", message: err.message || "Network error" } };
    }
  }

  async function schedulePage(fetchFn, { apiKey, apiUrl, url, cron }) {
    const base = (apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
    try {
      const resp = await post(fetchFn, base, "/api/v1/schedules", apiKey, {
        name: `Get API: ${url}`.slice(0, 255),
        urls: [url],
        formats: ["json"],
        cron: cron || "0 9 * * *",
      });
      if (!resp.ok) return { error: await readError(resp) };
      return { error: null, schedule: await resp.json() };
    } catch (err) {
      return { error: { code: "network", message: err.message || "Network error" } };
    }
  }

  const api = { buildSnippets, publishPrecheck, runGetApi, publishPage, schedulePage };
  root.AlterLabGetApi = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
