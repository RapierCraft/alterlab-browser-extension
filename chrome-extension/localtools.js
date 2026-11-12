/**
 * AlterLab Connect - Local tools
 *
 * Pure, dependency-free functions that analyse a page snapshot entirely on the
 * user's machine. This module performs no network I/O of any kind: callers
 * hand it the page HTML / cookie names / resource list and it returns data.
 *
 * Snapshot shape (built by content.js LOCAL_TOOLS_SNAPSHOT):
 *   { url, html, scripts: [src], cookies: [name], resources: [{ url, type }] }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AlterLabLocalTools = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Minimal HTML parser (no DOM: runs in Node tests and the side panel)
  // ---------------------------------------------------------------------
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  const RAW = new Set(["script", "style", "textarea", "title"]);
  const BLOCK = new Set(["p", "div", "ul", "ol", "table", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "section", "article", "header", "footer", "main", "nav", "aside", "form"]);
  const AUTOCLOSE = { li: ["li"], td: ["td", "th"], th: ["td", "th"], tr: ["tr", "td", "th"], p: ["p"], option: ["option"] };
  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©" };

  function decode(s) {
    return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
    });
  }

  function parseAttrs(src) {
    const attrs = {};
    const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m;
    while ((m = re.exec(src))) {
      attrs[m[1].toLowerCase()] = decode(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || "");
    }
    return attrs;
  }

  /** Parse HTML into { tag, attrs, children[] } nodes; text nodes are strings. */
  function parseHtml(html) {
    const rootNode = { tag: "#root", attrs: {}, children: [] };
    const stack = [rootNode];
    const top = () => stack[stack.length - 1];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|[^<]+|</g;
    let m;
    const src = String(html || "");
    while ((m = re.exec(src))) {
      const [full, closing, rawTag, attrSrc] = m;
      if (!rawTag) {
        if (full[0] !== "<" || full === "<") top().children.push(decode(full));
        else if (!full.startsWith("<!")) top().children.push(full);
        continue;
      }
      const tag = rawTag.toLowerCase();
      if (closing) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tag === tag) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      const closes = AUTOCLOSE[tag];
      if (closes && stack.some((n) => closes.includes(n.tag))) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (closes.includes(stack[i].tag)) {
            // Never close across a table/list boundary.
            stack.length = i;
            break;
          }
          if (["table", "ul", "ol"].includes(stack[i].tag)) break;
        }
      } else if (BLOCK.has(tag) && top().tag === "p") {
        stack.pop();
      }
      const node = { tag, attrs: parseAttrs(attrSrc), children: [] };
      top().children.push(node);
      if (VOID.has(tag) || /\/\s*$/.test(attrSrc)) continue;
      if (RAW.has(tag)) {
        const end = new RegExp("</" + tag + "\\s*>", "ig");
        end.lastIndex = re.lastIndex;
        const e = end.exec(src);
        const stop = e ? e.index : src.length;
        node.children.push(src.slice(re.lastIndex, stop));
        re.lastIndex = e ? e.index + e[0].length : src.length;
        continue;
      }
      stack.push(node);
    }
    return rootNode;
  }

  function walk(node, fn) {
    if (typeof node === "string") return;
    fn(node);
    for (const c of node.children) walk(c, fn);
  }

  function findAll(node, pred) {
    const out = [];
    walk(node, (n) => pred(n) && out.push(n));
    return out;
  }

  function textOf(node) {
    if (typeof node === "string") return node;
    if (["script", "style", "noscript", "svg"].includes(node.tag)) return "";
    return node.children.map(textOf).join("");
  }

  const clean = (s) => s.replace(/\s+/g, " ").trim();

  // ---------------------------------------------------------------------
  // Tool 2: protection detector
  // ---------------------------------------------------------------------
  function cookieMatches(sig, name) {
    const n = String(name).toLowerCase();
    const v = sig.name.toLowerCase();
    if (sig.mode === "prefix") return n.startsWith(v);
    if (sig.mode === "substring") return n.includes(v);
    return n === v;
  }

  /** Identify anti-bot vendors from scripts, cookie names and HTML markers. */
  function detectProtection(snap, signatures) {
    const vendors = (signatures && signatures.vendors) || {};
    const html = String((snap && snap.html) || "").toLowerCase();
    const scripts = ((snap && snap.scripts) || []).map((s) => String(s).toLowerCase());
    const cookies = (snap && snap.cookies) || [];
    const found = [];
    for (const [key, v] of Object.entries(vendors)) {
      const evidence = [];
      for (const u of v.scripts || []) {
        if (scripts.some((s) => s.includes(u))) evidence.push("script:" + u);
      }
      for (const c of v.cookies || []) {
        const hit = cookies.find((n) => cookieMatches(c, n));
        if (hit) evidence.push("cookie:" + hit);
      }
      for (const mk of v.markers || []) {
        if (html.includes(mk)) evidence.push("marker:" + mk);
      }
      if (evidence.length) found.push({ vendor: key, label: v.label || key, evidence: Array.from(new Set(evidence)) });
    }
    return found.sort((a, b) => b.evidence.length - a.evidence.length);
  }

  // ---------------------------------------------------------------------
  // Tool 1: tracker and cookie audit
  // ---------------------------------------------------------------------
  const TRACKER_HOSTS = {
    "google-analytics.com": ["Google", "analytics"],
    "googletagmanager.com": ["Google", "tag manager"],
    "doubleclick.net": ["Google", "advertising"],
    "googlesyndication.com": ["Google", "advertising"],
    "facebook.net": ["Meta", "advertising"],
    "facebook.com": ["Meta", "advertising"],
    "connect.facebook.net": ["Meta", "advertising"],
    "hotjar.com": ["Hotjar", "session replay"],
    "clarity.ms": ["Microsoft", "session replay"],
    "bing.com": ["Microsoft", "advertising"],
    "linkedin.com": ["LinkedIn", "advertising"],
    "licdn.com": ["LinkedIn", "advertising"],
    "twitter.com": ["X", "advertising"],
    "ads-twitter.com": ["X", "advertising"],
    "tiktok.com": ["TikTok", "advertising"],
    "segment.com": ["Segment", "analytics"],
    "segment.io": ["Segment", "analytics"],
    "mixpanel.com": ["Mixpanel", "analytics"],
    "amplitude.com": ["Amplitude", "analytics"],
    "fullstory.com": ["FullStory", "session replay"],
    "criteo.com": ["Criteo", "advertising"],
    "taboola.com": ["Taboola", "advertising"],
    "outbrain.com": ["Outbrain", "advertising"],
    "hubspot.com": ["HubSpot", "marketing"],
    "hs-scripts.com": ["HubSpot", "marketing"],
    "adobedtm.com": ["Adobe", "analytics"],
    "omtrdc.net": ["Adobe", "analytics"],
    "scorecardresearch.com": ["Comscore", "analytics"],
    "quantserve.com": ["Quantcast", "advertising"],
  };
  const COOKIE_TRACKERS = [
    [/^_ga/, "Google"],
    [/^_gid$/, "Google"],
    [/^_gcl_/, "Google"],
    [/^IDE$|^DSID$/, "Google"],
    [/^_fbp$|^_fbc$|^fr$/, "Meta"],
    [/^_hj/, "Hotjar"],
    [/^_clck$|^_clsk$|^MUID$/, "Microsoft"],
    [/^li_|^lidc$|^bcookie$/, "LinkedIn"],
    [/^_ttp$|^_tt_/, "TikTok"],
    [/^ajs_/, "Segment"],
    [/^mp_/, "Mixpanel"],
    [/^__hs|^hubspotutk$/, "HubSpot"],
    [/^_uetsid$|^_uetvid$/, "Microsoft"],
  ];

  function hostOf(url, base) {
    try {
      return new URL(url, base || undefined).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  const siteOf = (host) => host.split(".").slice(-2).join(".");

  function trackerFor(host) {
    const parts = host.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const hit = TRACKER_HOSTS[parts.slice(i).join(".")];
      if (hit) return { company: hit[0], category: hit[1] };
    }
    return null;
  }

  /** Group third-party trackers and tracking cookies by company; score privacy 0-100. */
  function auditTrackers(snap) {
    const pageHost = hostOf((snap && snap.url) || "");
    const pageSite = siteOf(pageHost);
    const urls = [...((snap && snap.scripts) || []), ...(((snap && snap.resources) || []).map((r) => r.url))];
    const html = String((snap && snap.html) || "");
    const re = /<(?:script|img|iframe)\b[^>]*?\ssrc\s*=\s*["']?([^"'\s>]+)/gi;
    let m;
    while ((m = re.exec(html))) urls.push(m[1]);
    const companies = {};
    const slot = (company, category) => (companies[company] = companies[company] || { company, categories: [], hosts: [], cookies: [] });
    for (const u of urls) {
      const host = hostOf(u, snap && snap.url);
      if (!host || siteOf(host) === pageSite) continue;
      const t = trackerFor(host);
      if (!t) continue;
      const c = slot(t.company);
      if (!c.categories.includes(t.category)) c.categories.push(t.category);
      if (!c.hosts.includes(host)) c.hosts.push(host);
    }
    for (const name of (snap && snap.cookies) || []) {
      const hit = COOKIE_TRACKERS.find(([re2]) => re2.test(name));
      if (hit) {
        const c = slot(hit[1]);
        if (!c.cookies.includes(name)) c.cookies.push(name);
      }
    }
    const groups = Object.values(companies).sort((a, b) => b.hosts.length + b.cookies.length - (a.hosts.length + a.cookies.length));
    let penalty = 0;
    for (const g of groups) {
      penalty += 6 * Math.min(g.hosts.length, 3) + 3 * Math.min(g.cookies.length, 3);
      if (g.categories.some((c) => c === "advertising" || c === "session replay")) penalty += 6;
    }
    return {
      companies: groups,
      trackerCount: groups.reduce((n, g) => n + g.hosts.length, 0),
      cookieCount: groups.reduce((n, g) => n + g.cookies.length, 0),
      score: Math.max(0, 100 - penalty),
    };
  }

  // ---------------------------------------------------------------------
  // Tool 3: page to markdown
  // ---------------------------------------------------------------------
  const SKIP = new Set(["script", "style", "noscript", "svg", "head", "template", "iframe", "form", "button", "select", "nav", "footer", "aside"]);

  function inline(node) {
    if (typeof node === "string") return node.replace(/\s+/g, " ");
    if (SKIP.has(node.tag)) return "";
    const kids = () => node.children.map(inline).join("");
    switch (node.tag) {
      case "strong":
      case "b": {
        const t = kids().trim();
        return t ? `**${t}**` : "";
      }
      case "em":
      case "i": {
        const t = kids().trim();
        return t ? `*${t}*` : "";
      }
      case "code":
        return "`" + textOf(node).replace(/`/g, "") + "`";
      case "br":
        return "  \n";
      case "a": {
        const t = kids().trim();
        const href = node.attrs.href;
        return t && href && !/^javascript:/i.test(href) ? `[${t}](${href})` : t;
      }
      case "img":
        return node.attrs.src ? `![${node.attrs.alt || ""}](${node.attrs.src})` : "";
      default:
        return kids();
    }
  }

  function tableToMarkdown(table) {
    const { headers, rows } = tableData(table);
    if (!headers.length && !rows.length) return "";
    const head = headers.length ? headers : rows[0].map(() => "");
    const body = headers.length ? rows : rows.slice(1);
    const esc = (c) => c.replace(/\|/g, "\\|");
    const line = (r) => "| " + head.map((_, i) => esc(r[i] || "")).join(" | ") + " |";
    return [line(head), "| " + head.map(() => "---").join(" | ") + " |", ...body.map(line)].join("\n");
  }

  function block(node, out, depth) {
    if (typeof node === "string") {
      if (node.trim()) out.push(clean(node));
      return;
    }
    if (SKIP.has(node.tag)) return;
    const tag = node.tag;
    if (/^h[1-6]$/.test(tag)) {
      const t = clean(inline(node));
      if (t) out.push("#".repeat(Number(tag[1])) + " " + t);
    } else if (tag === "p") {
      const t = inline(node).trim();
      if (t) out.push(t);
    } else if (tag === "pre") {
      out.push("```\n" + textOf(node).replace(/\n$/, "") + "\n```");
    } else if (tag === "blockquote") {
      const inner = [];
      node.children.forEach((c) => block(c, inner, depth));
      if (inner.length) out.push(inner.join("\n\n").split("\n").map((l) => "> " + l).join("\n"));
    } else if (tag === "ul" || tag === "ol") {
      const items = node.children.filter((c) => typeof c !== "string" && c.tag === "li");
      const lines = items.map((li, i) => {
        const parts = [];
        const nested = [];
        li.children.forEach((c) => (typeof c !== "string" && (c.tag === "ul" || c.tag === "ol") ? block(c, nested, depth + 1) : parts.push(inline(c))));
        const mark = tag === "ol" ? `${i + 1}.` : "-";
        const text = clean(parts.join(""));
        return "  ".repeat(depth) + mark + " " + text + (nested.length ? "\n" + nested.join("\n") : "");
      });
      if (lines.length) out.push(lines.join("\n"));
    } else if (tag === "hr") {
      out.push("---");
    } else if (tag === "table") {
      const md = tableToMarkdown(node);
      if (md) out.push(md);
    } else if (tag === "img") {
      const t = inline(node);
      if (t) out.push(t);
    } else {
      // Generic container: flush runs of inline content as paragraphs.
      let run = "";
      const flush = () => {
        const t = run.trim();
        if (t) out.push(t);
        run = "";
      };
      for (const c of node.children) {
        const isBlock = typeof c !== "string" && (BLOCK.has(c.tag) || /^h[1-6]$/.test(c.tag) || c.tag === "li" || c.tag === "hr");
        if (isBlock) {
          flush();
          block(c, out, depth);
        } else run += inline(c);
      }
      flush();
    }
  }

  /** Convert page HTML to clean markdown, preferring <main>/<article> content. */
  function toMarkdown(html) {
    const tree = parseHtml(html);
    const body = findAll(tree, (n) => n.tag === "body")[0] || tree;
    const main = findAll(body, (n) => n.tag === "main")[0] || findAll(body, (n) => n.tag === "article")[0] || body;
    const out = [];
    block(main, out, 0);
    const titleNode = findAll(tree, (n) => n.tag === "title")[0];
    const title = titleNode ? clean(textOf(titleNode)) : "";
    const md = out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    return md.startsWith("# ") || !title ? md : `# ${title}\n\n${md}`;
  }

  // ---------------------------------------------------------------------
  // Tool 4: structured data viewer
  // ---------------------------------------------------------------------
  function jsonLdTypes(v, out) {
    if (Array.isArray(v)) v.forEach((x) => jsonLdTypes(x, out));
    else if (v && typeof v === "object") {
      if (v["@type"]) out.push(...[].concat(v["@type"]).map(String));
      Object.values(v).forEach((x) => typeof x === "object" && jsonLdTypes(x, out));
    }
  }

  /** JSON-LD, microdata types, OpenGraph / Twitter / meta tags with validation hints. */
  function extractStructuredData(html) {
    const tree = parseHtml(html);
    const hints = [];
    const jsonLd = [];
    for (const s of findAll(tree, (n) => n.tag === "script" && /ld\+json/i.test(n.attrs.type || ""))) {
      const raw = (s.children[0] || "").trim();
      try {
        const data = JSON.parse(raw);
        const types = [];
        jsonLdTypes(data, types);
        jsonLd.push({ data, types });
        const items = [].concat(data["@graph"] || data);
        if (!items.some((i) => i && i["@context"]) && !data["@context"]) hints.push("JSON-LD block is missing @context");
        if (!types.length) hints.push("JSON-LD block has no @type");
      } catch (err) {
        hints.push("Invalid JSON-LD block: " + err.message);
      }
    }
    const metas = findAll(tree, (n) => n.tag === "meta");
    const openGraph = {};
    const twitter = {};
    const meta = {};
    for (const m of metas) {
      const key = (m.attrs.property || m.attrs.name || "").toLowerCase();
      const val = m.attrs.content;
      if (!key || val === undefined) continue;
      if (key.startsWith("og:")) openGraph[key.slice(3)] = val;
      else if (key.startsWith("twitter:")) twitter[key.slice(8)] = val;
      else meta[key] = val;
    }
    const titleNode = findAll(tree, (n) => n.tag === "title")[0];
    const canonical = findAll(tree, (n) => n.tag === "link" && (n.attrs.rel || "").toLowerCase() === "canonical")[0];
    const microdata = Array.from(new Set(findAll(tree, (n) => n.attrs && n.attrs.itemtype).map((n) => n.attrs.itemtype)));
    const schemaTypes = Array.from(new Set([...jsonLd.flatMap((j) => j.types), ...microdata.map((t) => t.split("/").pop())]));
    for (const k of ["title", "description", "image"]) {
      if (!openGraph[k]) hints.push(`Missing og:${k}`);
    }
    if (!meta.description) hints.push("Missing meta description");
    if (!canonical) hints.push("Missing canonical link");
    if (!jsonLd.length && !microdata.length) hints.push("No schema.org structured data found");
    return {
      title: titleNode ? clean(textOf(titleNode)) : "",
      canonical: canonical ? canonical.attrs.href || "" : "",
      jsonLd,
      microdata,
      schemaTypes,
      openGraph,
      twitter,
      meta,
      hints,
    };
  }

  // ---------------------------------------------------------------------
  // Tool 5: tables and lists to CSV / JSON
  // ---------------------------------------------------------------------
  function tableData(table) {
    const rows = [];
    let headers = [];
    for (const tr of findAll(table, (n) => n.tag === "tr")) {
      const cells = tr.children.filter((c) => typeof c !== "string" && (c.tag === "td" || c.tag === "th"));
      if (!cells.length) continue;
      const vals = cells.map((c) => clean(inline(c)).replace(/\n/g, " "));
      if (!headers.length && !rows.length && cells.every((c) => c.tag === "th")) headers = vals;
      else rows.push(vals);
    }
    return { headers, rows };
  }

  /** Every <table> plus every repeated list (3+ items) as { kind, headers, rows }. */
  function extractTables(html) {
    const tree = parseHtml(html);
    const out = [];
    for (const t of findAll(tree, (n) => n.tag === "table")) {
      const d = tableData(t);
      if (d.rows.length || d.headers.length) out.push({ kind: "table", name: clean(textOf(findAll(t, (n) => n.tag === "caption")[0] || "")) || "Table " + (out.length + 1), ...d });
    }
    for (const l of findAll(tree, (n) => n.tag === "ul" || n.tag === "ol")) {
      const items = l.children.filter((c) => typeof c !== "string" && c.tag === "li");
      if (items.length < 3 || findAll(l, (n) => n.tag === "table").length) continue;
      const rows = items.map((li) => [clean(inline(li))]).filter((r) => r[0]);
      if (rows.length >= 3) out.push({ kind: "list", name: "List " + (out.length + 1), headers: ["item"], rows });
    }
    return out;
  }

  function toCsv(table) {
    const q = (v) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
    const lines = [];
    if (table.headers.length) lines.push(table.headers.map(q).join(","));
    for (const r of table.rows) lines.push(r.map((v) => q(String(v))).join(","));
    return lines.join("\r\n") + "\r\n";
  }

  function toJson(table) {
    const keys = table.headers.length ? table.headers : (table.rows[0] || []).map((_, i) => "col" + (i + 1));
    return table.rows.map((r) => Object.fromEntries(keys.map((k, i) => [k || "col" + (i + 1), r[i] === undefined ? "" : r[i]])));
  }

  // ---------------------------------------------------------------------
  // Tool 6: network-to-API inspector
  // ---------------------------------------------------------------------
  /** Group the page's own XHR/fetch requests that look like JSON/API endpoints. */
  function summarizeEndpoints(resources, pageUrl) {
    const pageSite = siteOf(hostOf(pageUrl || ""));
    const byKey = new Map();
    for (const r of resources || []) {
      if (!["xmlhttprequest", "fetch", "xhr"].includes(String(r.type).toLowerCase())) continue;
      let u;
      try {
        u = new URL(r.url, pageUrl || undefined);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(u.protocol)) continue;
      const jsonLike = /\.json$|\/api\/|\/graphql|\/v\d+\/|\/_next\/data\/|\/wp-json\//i.test(u.pathname) || /[?&](format|output)=json/i.test(u.search);
      if (!jsonLike) continue;
      const key = u.origin + u.pathname;
      const e = byKey.get(key) || { url: r.url, endpoint: key, host: u.hostname, count: 0, sameSite: siteOf(u.hostname.toLowerCase()) === pageSite };
      e.count += 1;
      byKey.set(key, e);
    }
    return Array.from(byKey.values()).sort((a, b) => Number(b.sameSite) - Number(a.sameSite) || b.count - a.count);
  }

  // ---------------------------------------------------------------------
  // Tool 7: AI readiness (robots.txt + llms.txt)
  // ---------------------------------------------------------------------
  const AI_CRAWLERS = ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "Claude-Web", "anthropic-ai", "PerplexityBot", "Google-Extended", "Applebot-Extended", "CCBot", "Bytespider", "Amazonbot", "cohere-ai", "meta-externalagent"];

  function robotsGroups(text) {
    const groups = [];
    let cur = null;
    let lastWasAgent = false;
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim();
      const i = line.indexOf(":");
      if (i < 0) continue;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k === "user-agent") {
        if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
        cur.agents.push(v.toLowerCase());
        lastWasAgent = true;
      } else if (cur && (k === "allow" || k === "disallow")) {
        cur.rules.push([k, v]);
        lastWasAgent = false;
      }
    }
    return groups;
  }

  /** Per-AI-crawler access from robots.txt plus llms.txt presence. Inputs are plain text. */
  function parseAiReadiness(robotsTxt, llmsTxt) {
    const groups = robotsGroups(robotsTxt);
    const star = groups.find((g) => g.agents.includes("*"));
    const crawlers = AI_CRAWLERS.map((name) => {
      const g = groups.find((x) => x.agents.includes(name.toLowerCase()));
      const rules = (g || star || { rules: [] }).rules;
      let status = "allowed";
      if (rules.some(([k, v]) => k === "disallow" && v === "/") && !rules.some(([k, v]) => k === "allow" && v === "/")) status = "blocked";
      else if (rules.some(([k, v]) => k === "disallow" && v)) status = "partial";
      return { name, status, source: g ? "specific" : star ? "wildcard" : "default" };
    });
    const llms = String(llmsTxt || "").trim();
    const llmsPresent = !!llms && !/^<(!doctype|html)/i.test(llms);
    const sitemaps = (String(robotsTxt || "").match(/^\s*sitemap\s*:\s*\S+/gim) || []).length;
    const hints = [];
    if (!String(robotsTxt || "").trim()) hints.push("No robots.txt found: crawlers fall back to default access");
    if (!llmsPresent) hints.push("No llms.txt found: add one to point LLMs at your key pages");
    else if (!/^#\s+\S/m.test(llms)) hints.push("llms.txt has no H1 title line");
    if (!sitemaps) hints.push("robots.txt declares no Sitemap");
    const blocked = crawlers.filter((c) => c.status === "blocked").length;
    return { crawlers, blockedCount: blocked, llmsTxt: { present: llmsPresent, bytes: llmsPresent ? llms.length : 0 }, sitemaps, hints };
  }

  // ---------------------------------------------------------------------
  // Plain-text renderers for the side panel
  // ---------------------------------------------------------------------
  const format = {
    trackers(a) {
      const lines = [`Privacy score: ${a.score}/100`, `${a.trackerCount} third-party tracker hosts, ${a.cookieCount} tracking cookies`, ""];
      for (const c of a.companies) {
        lines.push(`${c.company} (${c.categories.join(", ") || "cookies"})`);
        c.hosts.forEach((h) => lines.push("  host: " + h));
        c.cookies.forEach((n) => lines.push("  cookie: " + n));
      }
      if (!a.companies.length) lines.push("No known trackers found.");
      return lines.join("\n");
    },
    protection(found) {
      return found.length ? found.map((f) => `${f.label}\n  ${f.evidence.join("\n  ")}`).join("\n") : "No known anti-bot vendor signatures on this page.";
    },
    structured(d) {
      const out = { title: d.title, canonical: d.canonical, schemaTypes: d.schemaTypes, jsonLd: d.jsonLd.map((j) => j.data), openGraph: d.openGraph, twitter: d.twitter, meta: d.meta };
      return JSON.stringify(out, null, 2) + (d.hints.length ? "\n\nHints:\n- " + d.hints.join("\n- ") : "");
    },
    endpoints(list) {
      return list.length ? list.map((e) => `${e.count}x ${e.endpoint}${e.sameSite ? "" : "  (third party)"}`).join("\n") : "No JSON/API requests seen yet. Interact with the page, then run again.";
    },
    aiReadiness(r) {
      const lines = r.crawlers.map((c) => `${c.name}: ${c.status}`);
      lines.push("", `llms.txt: ${r.llmsTxt.present ? "present" : "missing"}`, `Sitemaps: ${r.sitemaps}`);
      if (r.hints.length) lines.push("", "Hints:", ...r.hints.map((h) => "- " + h));
      return lines.join("\n");
    },
  };

  return { parseHtml, detectProtection, auditTrackers, toMarkdown, extractStructuredData, extractTables, toCsv, toJson, summarizeEndpoints, parseAiReadiness, format, AI_CRAWLERS };
});
