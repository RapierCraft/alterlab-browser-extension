/**
 * AlterLab Connect - BYOS session freshness, side panel UI.
 *
 * Notification bar (Update/Dismiss), the automatic-refresh toggle (off by
 * default; enabling asks for consent and per-site host permission), and the
 * per-site opt-out list showing which cookie names were last sent and when.
 * Logic lives in byos-refresh.js.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports)
    module.exports = factory(require("./byos-refresh.js"));
  else root.AlterLabByosUi = factory(root.AlterLabByos);
})(typeof self !== "undefined" ? self : this, function (B) {
  "use strict";

  function bindSidepanel(deps) {
    const { doc, chrome, consent, getBaseDomain, onStatus } = deps;
    const $ = (id) => doc.getElementById(id);
    const bar = $("byosBar");
    const toggle = $("autoRefreshToggle");
    if (!bar || !toggle) return;
    const state = B.createBarState();
    let autoRefresh = false;

    function render() {
      const next = state.next();
      if (!next) {
        bar.classList.add("hidden");
        return;
      }
      bar.dataset.domain = next.domain;
      bar.dataset.sessionId = next.sessionId;
      $("byosBarText").textContent =
        `Your ${next.domain} session cookies may have changed. Update?`;
      bar.classList.remove("hidden");
    }

    chrome.runtime.onMessage.addListener((message) => {
      if (message.type !== "BYOS_COOKIE_CHANGED") return;
      if (state.add(message.domain, message.sessionId, autoRefresh)) render();
    });

    $("byosDismissBtn").addEventListener("click", () => {
      state.dismiss(bar.dataset.domain);
      render();
    });

    $("byosUpdateBtn").addEventListener("click", async () => {
      const { domain, sessionId } = bar.dataset;
      if (!(await consent.requestUploadConsent(doc, chrome.storage.local)))
        return;
      try {
        const origins = [B.hostPattern(getBaseDomain(domain))];
        if (!(await chrome.permissions.contains({ origins }))) {
          if (!(await chrome.permissions.request({ origins }))) return;
        }
      } catch (e) {
        return;
      }
      const res = await chrome.runtime.sendMessage({
        type: "REFRESH_BYOS_COOKIES",
        domain,
        sessionId,
      });
      state.resolve(domain);
      render();
      renderDomains().catch(() => {});
      if (onStatus) onStatus(res && res.ok, domain, res && res.error);
    });

    const list = $("byosDomainList");

    /** Per-site opt-out checkboxes plus the cookie names last sent and when. */
    async function renderDomains() {
      if (!list) return;
      const [mapRes, sentRes, stored] = await Promise.all([
        chrome.runtime.sendMessage({ type: "GET_BYOS_DOMAINS" }),
        chrome.runtime.sendMessage({ type: "GET_BYOS_LAST_SENT" }),
        chrome.storage.local.get(B.DISABLED_KEY),
      ]);
      const disabled = stored[B.DISABLED_KEY] || [];
      const lastSent = (sentRes && sentRes.lastSent) || {};
      list.textContent = "";
      for (const domain of Object.keys((mapRes && mapRes.map) || {})) {
        const row = doc.createElement("div");
        const label = doc.createElement("label");
        const cb = doc.createElement("input");
        cb.type = "checkbox";
        cb.checked = !disabled.includes(domain);
        cb.addEventListener("change", async () => {
          const cur =
            (await chrome.storage.local.get(B.DISABLED_KEY))[B.DISABLED_KEY] ||
            [];
          const next = new Set(cur);
          if (cb.checked) next.delete(domain);
          else next.add(domain);
          await chrome.storage.local.set({ [B.DISABLED_KEY]: [...next] });
        });
        label.appendChild(cb);
        label.appendChild(doc.createTextNode(" " + domain));
        row.appendChild(label);
        const sent = lastSent[domain];
        if (sent) {
          const info = doc.createElement("div");
          info.textContent = `Last sent ${new Date(sent.at).toLocaleString()}: ${sent.names.join(", ")}`;
          row.appendChild(info);
        }
        list.appendChild(row);
      }
    }
    renderDomains().catch(() => {});

    chrome.storage.local.get(B.AUTO_REFRESH_KEY, (items) => {
      autoRefresh = (items || {})[B.AUTO_REFRESH_KEY] === true;
      toggle.checked = autoRefresh;
      if (autoRefresh) {
        state.clear();
        render();
      }
    });

    toggle.addEventListener("change", async () => {
      if (!toggle.checked) {
        autoRefresh = false;
        await chrome.storage.local.set({ [B.AUTO_REFRESH_KEY]: false });
        return;
      }
      let granted = false;
      try {
        const res = await chrome.runtime.sendMessage({
          type: "GET_BYOS_DOMAINS",
          force: true,
        });
        const origins = Object.keys((res && res.map) || {}).map((d) =>
          B.hostPattern(getBaseDomain(d)),
        );
        granted =
          (await consent.requestUploadConsent(doc, chrome.storage.local)) &&
          origins.length > 0 &&
          (await chrome.permissions.request({ origins }));
      } catch (e) {
        granted = false;
      }
      autoRefresh = granted;
      toggle.checked = granted;
      await chrome.storage.local.set({ [B.AUTO_REFRESH_KEY]: granted });
      if (granted) {
        state.clear();
        render();
      }
    });
  }

  return { bindSidepanel };
});
