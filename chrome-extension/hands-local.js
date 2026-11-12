/**
 * AlterLab Connect - Hands local execution (#38946).
 *
 * A Hands task created with `execution: "local"` runs in THIS browser: the extension polls the
 * API for the task's steps, runs each action in a dedicated tab of the user's own profile and
 * posts back a redacted result. The session (cookies, storage) never leaves the device: this
 * module never reads cookies and only ever talks to /api/v1/hands/. While a task runs the tab
 * carries a visible "agent working" banner with a Stop button, and the toolbar badge shows it.
 * Stop is instant: the in-flight poll is aborted, the tab is closed and the API is told.
 */
(function (root) {
  "use strict";

  const DISCOVER_ALARM = "alterlab-hands-local";
  const DISCOVER_MINUTES = 1;
  const STOP_MESSAGE = "alterlab-hands-local-stop";
  const API = "/api/v1/hands";
  const OBSERVE_TEXT_MAX = 20000;
  const LOAD_TIMEOUT_MS = 30000;
  const SUPPORTED = new Set([
    "navigate", "click", "click_text", "fill", "press", "scroll", "scroll_into_view", "hover",
    "select", "check", "uncheck", "wait", "wait_for", "assert", "snapshot",
  ]);

  // ---- helpers -------------------------------------------------------------------------

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (_) {
      return "";
    }
  }

  function hostAllowed(url, domains) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return false;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase();
    return (domains || []).some((d) => host === d || host.endsWith("." + d));
  }

  // ---- injected page functions (self-contained: serialised into the tab) ----------------

  /** Runs inside the page; one action in, a small JSON-safe outcome out. */
  function pageAction(action) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const find = (sel) => {
      try {
        return document.querySelector(sel);
      } catch (_) {
        return null;
      }
    };
    const waitFor = async (sel, state, timeout) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const el = find(sel);
        const visible = !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        if (state === "visible" && visible) return true;
        if (state === "attached" && el) return true;
        if (state === "hidden" && !visible) return true;
        if (state === "detached" && !el) return true;
        await sleep(100);
      }
      return false;
    };
    const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
    return (async () => {
      const t = action.type;
      if (t === "scroll") {
        const dy = (action.direction === "up" ? -1 : 1) * (action.amount || 600);
        window.scrollBy(0, dy);
        return { ok: true };
      }
      if (t === "wait" && !action.selector) {
        await sleep(Math.min(action.milliseconds || 0, 30000));
        return { ok: true };
      }
      if (t === "wait" || t === "wait_for") {
        const state = t === "wait" ? "visible" : action.state || "visible";
        const ok = await waitFor(action.selector, state, action.timeout || action.timeout_ms || 10000);
        return ok ? { ok: true } : { ok: false, error: "wait_timeout" };
      }
      if (t === "click_text") {
        const want = action.exact ? action.text : action.text.toLowerCase();
        const nodes = document.querySelectorAll("a,button,[role=button],input[type=submit],label,span,div");
        for (const n of nodes) {
          const text = (n.innerText || n.value || "").trim();
          if (action.exact ? text === want : text.toLowerCase().includes(want)) {
            n.click();
            return { ok: true };
          }
        }
        return { ok: false, error: "element_not_found" };
      }
      if (t === "press") {
        const el = (action.selector && find(action.selector)) || document.activeElement || document.body;
        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(type, { key: action.key, bubbles: true }));
        }
        if (action.key === "Enter" && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
        return { ok: true };
      }
      if (t === "snapshot") {
        const body = action.format === "markdown" ? document.body.innerText : document.documentElement.outerHTML;
        return { ok: true, snapshot: String(body).slice(0, 20000) };
      }
      if (t === "assert") {
        if (action.url_contains && !location.href.includes(action.url_contains)) return { ok: false, error: "assertion_failed" };
        if (action.text && !document.body.innerText.includes(action.text)) {
          const end = Date.now() + (action.timeout_ms || 0);
          while (Date.now() < end && !document.body.innerText.includes(action.text)) await sleep(100);
          if (!document.body.innerText.includes(action.text)) return { ok: false, error: "assertion_failed" };
        }
        if (action.selector && !(await waitFor(action.selector, "attached", action.timeout_ms || 0))) {
          return { ok: false, error: "assertion_failed" };
        }
        return { ok: true };
      }
      const el = find(action.selector);
      if (!el) return { ok: false, error: "element_not_found" };
      if (t === "scroll_into_view") el.scrollIntoView({ block: action.block || "center" });
      else if (t === "hover") {
        for (const type of ["mouseover", "mouseenter", "mousemove"]) el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      } else if (t === "click") el.click();
      else if (t === "fill") {
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value");
        if (setter && setter.set) setter.set.call(el, action.value);
        else el.value = action.value;
        fire(el, "input");
        fire(el, "change");
      } else if (t === "select") {
        const opt = Array.from(el.options || []).find((o) => (action.value != null ? o.value === action.value : o.label === action.label));
        if (!opt) return { ok: false, error: "option_not_found" };
        el.value = opt.value;
        fire(el, "input");
        fire(el, "change");
      } else if (t === "check" || t === "uncheck") {
        const want = t === "check";
        if (el.checked !== want) el.click();
      }
      return { ok: true };
    })();
  }

  /** Runs inside the page: a bounded, redacted view (visible text only; no cookies, no storage). */
  function pageObserve(maxText) {
    return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, maxText) };
  }

  /** Runs inside the page: the visible "agent working" banner with a Stop button. */
  function pageBanner(taskId, stopMessage, show) {
    const id = "alterlab-hands-local-banner";
    const old = document.getElementById(id);
    if (old) old.remove();
    if (!show) return;
    const bar = document.createElement("div");
    bar.id = id;
    bar.setAttribute("style", "position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:center;padding:6px 12px;background:#4f46e5;color:#fff;font:600 13px system-ui,sans-serif");
    const label = document.createElement("span");
    label.textContent = "AlterLab agent working in this tab";
    const stop = document.createElement("button");
    stop.textContent = "Stop";
    stop.setAttribute("style", "background:#fff;color:#4f46e5;border:0;border-radius:4px;padding:2px 10px;font:inherit;cursor:pointer");
    stop.addEventListener("click", () => chrome.runtime.sendMessage({ type: stopMessage, taskId }));
    bar.append(label, stop);
    document.documentElement.appendChild(bar);
  }

  // ---- extension-side executor ------------------------------------------------------------

  async function inTab(deps, tabId, func, args) {
    const [res] = await deps.executeScript(tabId, func, args);
    return res ? res.result : undefined;
  }

  async function showBanner(deps, ctx, show) {
    try {
      await inTab(deps, ctx.tabId, pageBanner, [ctx.task.id, STOP_MESSAGE, show]);
    } catch (_) {
      /* tab navigating or closed; re-shown after the next action */
    }
  }

  async function observe(deps, ctx) {
    const obs = await inTab(deps, ctx.tabId, pageObserve, [OBSERVE_TEXT_MAX]);
    return obs || { url: null };
  }

  async function runAction(deps, ctx, action) {
    if (!SUPPORTED.has(action.type)) return { ok: false, error: "unsupported_in_local_mode" };
    if (action.type === "navigate") {
      if (!hostAllowed(action.url, ctx.task.domains)) return { ok: false, error: "domain_not_allowed" };
      await deps.navigate(ctx.tabId, action.url, LOAD_TIMEOUT_MS);
      return { ok: true };
    }
    const out = await inTab(deps, ctx.tabId, pageAction, [action]);
    if (action.type === "click" || action.type === "click_text" || action.type === "press") {
      await deps.settle(ctx.tabId);
    }
    return out || { ok: false, error: "no_result" };
  }

  /** Runs one act/observe step; returns the redacted payload posted to the API. */
  async function runStep(deps, ctx, step) {
    if (step.op === "observe") {
      return { step_id: step.step_id, status: "running", action_results: [], observation: await observe(deps, ctx) };
    }
    const results = [];
    for (const [index, action] of (step.actions || []).entries()) {
      if (ctx.stopped) return { step_id: step.step_id, status: "closed", failure_reason: "closed_by_user", action_results: results };
      const out = await runAction(deps, ctx, action);
      results.push({ index, type: action.type, ...out });
      const tab = await deps.getTab(ctx.tabId);
      if (tab && tab.url && !hostAllowed(tab.url, ctx.task.domains)) {
        return { step_id: step.step_id, status: "failed", failure_reason: "domain_violation", action_results: results };
      }
      if (!out.ok && action.type === "assert") {
        return { step_id: step.step_id, status: "failed", failure_reason: "assertion_failed", action_results: results };
      }
      if (!out.ok && action.on_error !== "continue" && !action.optional) break;
    }
    await showBanner(deps, ctx, true);
    return { step_id: step.step_id, status: "running", action_results: results, observation: await observe(deps, ctx) };
  }

  // ---- task channel client ----------------------------------------------------------------

  function call(deps, ctx, path, init) {
    return deps.fetch(`${deps.baseUrl}${API}${path}`, {
      credentials: "include",
      ...init,
      headers: { "Content-Type": "application/json", ...(deps.headers || {}), ...((init || {}).headers || {}) },
    });
  }

  async function listTasks(deps) {
    const resp = await call(deps, null, "/local/tasks", {});
    if (!resp.ok) return [];
    const rows = await resp.json();
    return Array.isArray(rows) ? rows : [];
  }

  function cleanup(deps, ctx) {
    deps.running.delete(ctx.task.id);
    if (deps.running.size === 0) deps.setBadge("");
    return deps.closeTab(ctx.tabId).catch(() => {});
  }

  /** Instant stop: abort the poll, close the tab, then tell the API (the task closes there). */
  async function stopTask(deps, taskId) {
    const ctx = deps.running.get(taskId);
    if (!ctx) return false;
    ctx.stopped = true;
    if (ctx.abort) ctx.abort.abort();
    await cleanup(deps, ctx);
    try {
      await call(deps, ctx, `/tasks/${taskId}/local/stop`, { method: "POST" });
    } catch (_) {
      /* offline: the API closes the task at its TTL */
    }
    return true;
  }

  async function runTask(deps, task) {
    if (deps.running.has(task.id)) return;
    const tabId = await deps.openTab(task.start_url);
    const ctx = { task, tabId, stopped: false, abort: null };
    deps.running.set(task.id, ctx);
    deps.setBadge("AI");
    await showBanner(deps, ctx, true);
    try {
      while (!ctx.stopped) {
        ctx.abort = deps.newAbort();
        let next;
        try {
          const resp = await call(deps, ctx, `/tasks/${task.id}/local/next`, { signal: ctx.abort.signal });
          if (!resp.ok) break;
          next = await resp.json();
        } catch (err) {
          if (ctx.stopped) break;
          throw err;
        }
        const step = next.step;
        if (step && step.op === "close") break;
        if (!step) continue;
        const payload = await runStep(deps, ctx, step);
        if (ctx.stopped) break;
        await call(deps, ctx, `/tasks/${task.id}/local/result`, { method: "POST", body: JSON.stringify(payload) });
        if (payload.status === "failed") break;
      }
    } finally {
      if (!ctx.stopped) await cleanup(deps, ctx);
    }
  }

  async function discover(deps) {
    const tasks = await listTasks(deps);
    for (const task of tasks) {
      if (!deps.running.has(task.id)) runTask(deps, task).catch(() => deps.running.delete(task.id));
    }
    return tasks;
  }

  const api = {
    DISCOVER_ALARM, DISCOVER_MINUTES, STOP_MESSAGE, SUPPORTED,
    hostAllowed, hostOf, pageAction, runAction, runStep, listTasks, discover, runTask, stopTask,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AlterLabHandsLocal = api;
})(typeof self !== "undefined" ? self : this);
