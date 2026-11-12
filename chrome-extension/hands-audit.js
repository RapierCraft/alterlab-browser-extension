/**
 * AlterLab Connect - Hands action audit view (#39547).
 *
 * Reads the caller's Hands action audit and restriction alerts so the activity page can list
 * agent actions and warn that writes are paused. Read-only.
 * `deps` is injected: { fetch, getConfig } with getConfig() -> { apiUrl, apiKey }.
 */
(function (root) {
  "use strict";

  async function get(deps, path) {
    const cfg = await deps.getConfig();
    if (!cfg || !cfg.apiKey) return null;
    const resp = await deps.fetch(`${cfg.apiUrl}/api/v1/hands${path}`, {
      headers: { "X-API-Key": cfg.apiKey },
    });
    if (!resp.ok) return null;
    return resp.json();
  }

  /** Restriction alerts that still pause writes, newest first. */
  async function fetchAlerts(deps) {
    const body = await get(deps, "/alerts");
    return ((body && body.alerts) || []).filter((a) => a.writes_paused);
  }

  /** The caller's Hands action audit rows (newest first), mapped for display. */
  async function fetchAudit(deps, limit) {
    const body = await get(deps, `/audit?limit=${limit || 50}`);
    return ((body && body.entries) || []).map((e) => ({
      at: e.created_at,
      site: e.site,
      action: e.action_type,
      outcome: e.outcome,
      approvalRef: e.approval_ref || "",
    }));
  }

  function describeAlert(alert) {
    const until = alert.cooldown_until ? ` until ${alert.cooldown_until}` : "";
    return `Writes on ${alert.site} are paused${until} (${alert.signal}).`;
  }

  const api = { fetchAudit, fetchAlerts, describeAlert };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AlterLabHandsAudit = api;
})(typeof self !== "undefined" ? self : this);
