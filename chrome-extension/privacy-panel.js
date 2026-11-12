// Privacy dashboard for the side panel (#38949): what is stored where, per-site
// toggles, global controls, permissions manager, export and delete.
// All logic lives in privacy.js / connect.js; this file only renders and wires.
(function (root) {
  "use strict";

  const NOTICE =
    "AlterLab Connect only reads cookies and site data for sites you approve, one site at a time. " +
    "Approved sessions are encrypted in this extension before upload, and AlterLab cannot read them. " +
    "You can pause agents, switch to local-only mode, set how long sessions are kept, export what AlterLab " +
    "holds, or delete it, from this page.";

  function el(tag, text, attrs) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
  }

  function button(label, onClick) {
    const b = el("button", label, { class: "btn btn-secondary btn-sm", type: "button" });
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await onClick();
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  function check(label, checked, onChange) {
    const wrap = el("label", null, { style: "display:flex;gap:6px;align-items:center;font-size:12px" });
    const box = el("input", null, { type: "checkbox" });
    box.checked = checked;
    box.addEventListener("change", () => onChange(box.checked));
    wrap.appendChild(box);
    wrap.appendChild(el("span", label));
    return wrap;
  }

  function section(parent, title) {
    const s = el("div", null, { style: "margin-top:12px" });
    s.appendChild(el("div", title, { style: "font-weight:600;font-size:12px;margin-bottom:4px" }));
    parent.appendChild(s);
    return s;
  }

  function download(name, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = el("a", null, { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
  }

  /** deps: { storage, getConfig, fetch, now, removeOrigin, getAllPermissions } */
  async function render(container, deps) {
    const P = root.AlterLabPrivacy;
    const C = root.AlterLabConnect;
    const settings = await P.getSettings(deps.storage);
    const sites = await C.listConnected(deps.storage);
    const rerender = () => render(container, deps);
    container.textContent = "";
    const status = el("div", "", { style: "font-size:12px;margin-top:8px", role: "status" });

    const run = (fn) => async () => {
      try {
        await fn();
        await rerender();
      } catch (e) {
        status.textContent = e.message || "Something went wrong";
      }
    };

    container.appendChild(el("p", NOTICE, { style: "font-size:12px;color:var(--text-muted)" }));

    const global = section(container, "Global controls");
    global.appendChild(
      check("Local-only mode: never upload sessions to AlterLab", settings.localOnly, (v) =>
        run(() => P.setGlobal(deps.storage, { localOnly: v }))(),
      ),
    );
    global.appendChild(
      check("Pause all agent activity", settings.paused, (v) => run(() => P.setGlobal(deps.storage, { paused: v }))()),
    );
    const retention = el("select", null, { "aria-label": "Session retention" });
    for (const days of P.RETENTION_OPTIONS) {
      const o = el("option", days ? `${days} days` : "Until revoked", { value: String(days) });
      if (days === settings.retentionDays) o.selected = true;
      retention.appendChild(o);
    }
    retention.addEventListener("change", () =>
      run(() =>
        P.setGlobal(deps.storage, { retentionDays: retention.value === "null" ? null : Number(retention.value) }),
      )(),
    );
    const retentionRow = el("label", "Keep sessions for ", { style: "font-size:12px;display:block" });
    retentionRow.appendChild(retention);
    global.appendChild(retentionRow);

    const sitesBox = section(container, "Connected sites");
    if (!sites.length) sitesBox.appendChild(el("div", "No connected sites.", { style: "font-size:12px" }));
    for (const s of sites) {
      const policy = settings.sites[s.domain] || P.normalize({ sites: { [s.domain]: {} } }).sites[s.domain];
      const row = el("div", null, { style: "border-top:1px solid var(--border);padding:6px 0" });
      const last = s.lastPushAt ? new Date(s.lastPushAt).toLocaleString() : "never";
      row.appendChild(el("div", `${s.domain} (${(s.scopes || []).join(", ")}), last used ${last}`, { style: "font-size:12px" }));
      row.appendChild(
        check("Never capture on this site", policy.never, (v) => run(() => P.setSite(deps.storage, s.domain, { never: v }))()),
      );
      row.appendChild(
        check("Read only (no writes)", policy.mode === "read", (v) =>
          run(() => P.setSite(deps.storage, s.domain, { mode: v ? "read" : "write_approval" }))(),
        ),
      );
      row.appendChild(
        check("Auto-refresh", policy.autoRefresh, (v) => run(() => P.setSite(deps.storage, s.domain, { autoRefresh: v }))()),
      );
      row.appendChild(button("Revoke", run(() => C.revokeSite(s.domain, deps))));
      sitesBox.appendChild(row);
    }
    const never = el("input", null, { type: "text", placeholder: "example.com", "aria-label": "Site to never capture" });
    const addNever = button("Never capture this site", run(async () => {
      const domain = never.value.trim().toLowerCase();
      if (domain) await P.setSite(deps.storage, domain, { never: true });
    }));
    sitesBox.appendChild(never);
    sitesBox.appendChild(addNever);

    const local = section(container, "Stored in this extension");
    for (const item of await P.inventoryLocal(deps.storage)) {
      const row = el("div", `${item.label}: ${item.count ? "stored" : "empty"} `, { style: "font-size:12px" });
      if (item.count && !item.revokeOnly) row.appendChild(button("Clear", run(() => P.clearLocal(deps.storage, item.id))));
      local.appendChild(row);
    }

    const remote = section(container, "Held by AlterLab");
    for (const item of P.REMOTE_CATEGORIES) {
      remote.appendChild(el("div", item.note ? `${item.label}: ${item.note}` : item.label, { style: "font-size:12px" }));
    }
    remote.appendChild(
      button("Export my data", run(async () => download("alterlab-session-data.json", await P.exportRemote(deps)))),
    );
    remote.appendChild(
      button("Delete all my data", run(async () => {
        if (!root.confirm("Permanently delete all sessions and audit data held by AlterLab?")) return;
        await P.deleteAllRemote({ ...deps });
      })),
    );

    const perms = section(container, "Host permissions");
    const origins = await P.listPermissions(deps);
    if (!origins.length) perms.appendChild(el("div", "No site permissions granted.", { style: "font-size:12px" }));
    for (const origin of origins) {
      const row = el("div", origin + " ", { style: "font-size:12px" });
      row.appendChild(button("Remove", run(() => P.revokePermission(origin, deps))));
      perms.appendChild(row);
    }
    container.appendChild(status);
  }

  function init() {
    const container = document.getElementById("privacyPanel");
    if (!container) return;
    const deps = {
      storage: chrome.storage.local,
      getConfig: loadConfig,
      fetch: (...a) => fetch(...a),
      now: () => Date.now(),
      removeOrigin: (p) => chrome.permissions.remove({ origins: [p] }),
      getAllPermissions: () => chrome.permissions.getAll(),
    };
    const open = () => render(container, deps).catch(() => {});
    const details = document.getElementById("privacyDetails");
    if (details) details.addEventListener("toggle", () => details.open && open());
    else open();
  }

  root.AlterLabPrivacyPanel = { init, render, NOTICE };
})(typeof globalThis !== "undefined" ? globalThis : this);
