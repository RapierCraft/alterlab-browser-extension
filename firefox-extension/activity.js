// Activity and revoke panel: connected sites and the last 50 Hands actions (action audit).
(function () {
  "use strict";
  const C = globalThis.AlterLabConnect;

  async function deps() {
    return {
      storage: chrome.storage.local,
      getConfig: loadConfig,
      fetch: (...a) => fetch(...a),
      removeOrigin: (p) => chrome.permissions.remove({ origins: [p] }),
    };
  }

  function cell(tr, text) {
    const td = document.createElement("td");
    td.textContent = text == null ? "" : String(text);
    tr.appendChild(td);
    return td;
  }

  async function render() {
    const d = await deps();
    const sites = await C.listConnected(d.storage);
    const siteBody = document.getElementById("sites");
    siteBody.textContent = "";
    document.getElementById("sitesEmpty").hidden = sites.length > 0;
    for (const s of sites) {
      const tr = document.createElement("tr");
      cell(tr, s.domain);
      cell(tr, s.scopes.join(", "));
      cell(tr, s.expired ? "sign in again" : "connected");
      const btn = document.createElement("button");
      btn.textContent = "Revoke";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await C.revokeSite(s.domain, d);
        } finally {
          render();
        }
      });
      cell(tr, "").appendChild(btn);
      siteBody.appendChild(tr);
    }
    const eventBody = document.getElementById("events");
    eventBody.textContent = "";
    const err = document.getElementById("error");
    err.hidden = true;
    try {
      for (const e of await C.fetchActivity(d)) {
        const tr = document.createElement("tr");
        cell(tr, e.at);
        cell(tr, e.domain);
        cell(tr, e.agent);
        cell(tr, e.task);
        cell(tr, e.action);
        cell(tr, e.outcome);
        eventBody.appendChild(tr);
      }
    } catch (e) {
      err.textContent = "Could not load activity: " + e.message;
      err.hidden = false;
    }
  }

  async function renderAgentActions(d) {
    const A = globalThis.AlterLabHandsAudit;
    const body = document.getElementById("agentActions");
    body.textContent = "";
    const empty = document.getElementById("agentActionsEmpty");
    empty.hidden = true;
    try {
      const rows = await A.fetchAudit(d);
      empty.hidden = rows.length > 0;
      for (const r of rows) {
        const tr = document.createElement("tr");
        cell(tr, r.at);
        cell(tr, r.site);
        cell(tr, r.action);
        cell(tr, r.outcome);
        cell(tr, r.approvalRef);
        body.appendChild(tr);
      }
    } catch (_) {
      // Advisory section; the panel above still renders.
    }
  }

  async function renderAlertBanner(d) {
    const A = globalThis.AlterLabHandsAudit;
    const banner = document.getElementById("alertBanner");
    banner.hidden = true;
    try {
      const alerts = await A.fetchAlerts(d);
      if (!alerts.length) return;
      banner.textContent = alerts.map(A.describeAlert).join(" ");
      banner.hidden = false;
    } catch (_) {
      // The banner is advisory; the action table above still renders.
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    await render();
    const d = await deps();
    await renderAgentActions(d);
    await renderAlertBanner(d);
  });
})();
