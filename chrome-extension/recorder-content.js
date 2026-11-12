/**
 * AlterLab Connect: recorder content script (#38945).
 * Injected by the background worker into ONE tab only after the user starts a
 * recording. Reports click/input/change/submit/navigation descriptors. It never
 * reads or sends field values, and shows a visible banner while active.
 */
(function () {
  "use strict";
  if (window.__alterlabRecorder) return;
  const BANNER_ID = "alterlab-recorder-banner";
  const origin = location.origin;
  let active = true;

  function describe(el) {
    if (!el || !el.tagName) return {};
    const path = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body && path.length < 4; n = n.parentElement) {
      const idx = n.parentElement ? Array.prototype.indexOf.call(n.parentElement.children, n) + 1 : 1;
      path.unshift(`${n.tagName.toLowerCase()}:nth-child(${idx})`);
    }
    return {
      tag: el.tagName,
      id: el.id || "",
      testid: el.getAttribute("data-testid") || "",
      name: el.getAttribute("name") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      placeholder: el.getAttribute("placeholder") || "",
      type: el.getAttribute("type") || "",
      autocomplete: el.getAttribute("autocomplete") || "",
      path,
    };
  }

  function send(kind, el) {
    if (!active || location.origin !== origin) return;
    try {
      chrome.runtime.sendMessage({
        type: "RECORDER_EVENT",
        event: { kind, url: location.href, target: el ? describe(el) : undefined },
      });
    } catch (_) {
      /* extension reloaded */
    }
  }

  const onClick = (e) => {
    if (e.target && e.target.closest && e.target.closest(`#${BANNER_ID}`)) return;
    const el = e.target && e.target.closest ? e.target.closest("a,button,input,select,[role=button],[data-testid]") || e.target : e.target;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(submit|button|checkbox|radio)$/.test(el.type || "")) return;
    send("click", el);
  };
  const onInput = (e) => send("input", e.target);
  const onChange = (e) => {
    if (e.target && e.target.tagName === "SELECT") send("change", e.target);
  };
  const onSubmit = (e) => send("submit", e.target && e.target.querySelector ? e.target.querySelector("[type=submit],button") || e.target : e.target);

  document.addEventListener("click", onClick, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("submit", onSubmit, true);

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.setAttribute("role", "status");
  banner.style.cssText =
    "position:fixed;z-index:2147483647;top:0;left:0;right:0;padding:6px 12px;background:#b91c1c;color:#fff;font:600 13px system-ui;text-align:center";
  banner.textContent = "AlterLab is recording this tab (typed values are not saved). Stop it from the AlterLab panel.";
  document.documentElement.appendChild(banner);

  function stop() {
    active = false;
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("submit", onSubmit, true);
    banner.remove();
    delete window.__alterlabRecorder;
  }
  window.__alterlabRecorder = { stop };
  send("navigate", null);
})();
