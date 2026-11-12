/**
 * AlterLab Connect: recipe recorder core (#38945).
 *
 * Pure, dependency-free logic: selector generation, sensitive-field detection,
 * parameter inference and draft building. Typed text is never read here: an
 * input event carries no value, and every typed or selected field becomes a named
 * parameter ({{inputs.x}} on the server) or a secret reference (fill_secret).
 * The Chrome and Firefox copies of this file are byte-identical.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AlterLabRecorder = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_STEPS = 100;
  const SENSITIVE_RE = /pass(word|wd)?|pwd|secret|token|otp|one-time|cvv|cvc|card|ssn|pin\b/i;
  const cssEscape = (s) => String(s).replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  const attr = (name, v) => `[${name}="${String(v).replace(/(["\\])/g, "\\$1")}"]`;

  /** Selector from an element descriptor, most stable first. */
  function selectorFor(d) {
    const tag = (d.tag || "*").toLowerCase();
    if (d.testid) return attr("data-testid", d.testid);
    if (d.id && !/\d{4,}/.test(d.id)) return `#${cssEscape(d.id)}`;
    if (d.name) return `${tag}${attr("name", d.name)}`;
    if (d.ariaLabel) return `${tag}${attr("aria-label", d.ariaLabel)}`;
    if (Array.isArray(d.path) && d.path.length) return d.path.join(" > ");
    return tag;
  }

  function isSensitive(d) {
    if (String(d.type || "").toLowerCase() === "password") return true;
    const ac = String(d.autocomplete || "");
    if (/password|cc-|one-time-code/i.test(ac)) return true;
    return SENSITIVE_RE.test([d.name, d.id, d.ariaLabel].filter(Boolean).join(" "));
  }

  function toIdentifier(s) {
    const id = String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    return id && /^[a-z_]/.test(id) ? id : id ? `p_${id}` : "";
  }

  function sameSite(a, b) {
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch (_) {
      return false;
    }
  }

  /**
   * A recording session bound to one tab and one origin. Events from any other tab
   * or origin are ignored. Serialisable via toJSON for service-worker restarts.
   */
  function createSession(opts) {
    const state = {
      tabId: opts.tabId,
      origin: new URL(opts.startUrl).origin,
      startUrl: opts.startUrl,
      steps: [],
      active: true,
    };
    const names = new Set();

    function paramName(d) {
      const base = toIdentifier(d.ariaLabel || d.name || d.placeholder || d.id) || "value";
      let name = base;
      for (let n = 2; names.has(name); n += 1) name = `${base}_${n}`;
      names.add(name);
      return name;
    }

    function add(event) {
      if (!state.active || state.steps.length >= MAX_STEPS) return false;
      if (event.tabId !== state.tabId || !sameSite(event.url || state.startUrl, state.origin)) {
        return false;
      }
      const d = event.target || {};
      const last = state.steps[state.steps.length - 1];
      if (event.kind === "navigate") {
        if (last && last.type === "navigate" && last.url === event.url) return false;
        state.steps.push({ type: "navigate", url: event.url });
      } else if (event.kind === "click" || event.kind === "submit") {
        state.steps.push({ type: event.kind === "submit" ? "submit" : "click", selector: selectorFor(d) });
      } else if (event.kind === "input" || event.kind === "change") {
        const selector = selectorFor(d);
        const isSelect = String(d.tag).toLowerCase() === "select";
        if (last && last.selector === selector && (last.param || last.secret)) return false;
        const step = { type: isSelect ? "select" : "type", selector };
        if (isSensitive(d) && !isSelect) step.secret = paramName({ name: d.name || "secret" });
        else step.param = paramName(d);
        state.steps.push(step);
      } else {
        return false;
      }
      return true;
    }

    return {
      add,
      stop() {
        state.active = false;
        return state.steps.slice();
      },
      get active() {
        return state.active;
      },
      get origin() {
        return state.origin;
      },
      toJSON: () => ({ ...state, names: [...names] }),
    };
  }

  /** Server payload from the reviewed steps. Steps never contain typed values. */
  function buildRecipeDraft(session, name) {
    const steps = session.stop().map((s) => {
      const out = { type: s.type };
      for (const k of ["url", "selector", "param", "secret"]) if (s[k]) out[k] = s[k];
      return out;
    });
    const parameters = steps.filter((s) => s.param).map((s) => s.param);
    const secrets = steps.filter((s) => s.secret).map((s) => s.secret);
    return {
      payload: { name, start_url: session.toJSON().startUrl, steps },
      parameters,
      secrets,
    };
  }

  /** Rename a parameter or secret in the draft during review; names stay identifiers. */
  function renameField(steps, from, to) {
    const id = toIdentifier(to);
    if (!id) throw new Error("Name must contain letters or digits");
    return steps.map((s) => ({
      ...s,
      ...(s.param === from ? { param: id } : {}),
      ...(s.secret === from ? { secret: id } : {}),
    }));
  }

  return { selectorFor, isSensitive, toIdentifier, sameSite, createSession, buildRecipeDraft, renameField, MAX_STEPS };
});
