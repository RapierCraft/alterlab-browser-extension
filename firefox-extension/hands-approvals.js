/**
 * AlterLab Connect - Hands approvals (#38937).
 *
 * Polls the caller's pending Hands requests (questions, write-action approvals, connect
 * requests), shows each with its preview in a notification with Approve / Deny buttons, and
 * posts the decision back. Only the API decides: the extension never runs the action itself.
 * Writes are bound server-side to the payload hash, so the preview shown is what is approved.
 */
(function (root) {
  "use strict";

  const POLL_ALARM = "alterlab-hands-approvals";
  const POLL_MINUTES = 1;
  const NOTIFY_PREFIX = "alterlab-hands:";

  function describe(req) {
    if (req.kind === "approval") {
      const actions = ((req.preview || {}).actions || [])
        .map((a) => `${a.type}${a.selector ? " " + a.selector : ""}`)
        .join(", ");
      return { title: `Approve action on ${req.site || "site"}?`, message: actions || "Write action" };
    }
    if (req.kind === "human") {
      const reason = ((req.preview || {}).reason || "human step").replace(/_/g, " ");
      return { title: `You need to do this: ${reason}`, message: req.prompt || "" };
    }
    if (req.kind === "connect") return { title: "Sign-in needed", message: req.prompt || "" };
    return { title: "Your agent has a question", message: req.prompt || "" };
  }

  async function fetchPending(deps) {
    const resp = await deps.fetch(`${deps.baseUrl}/api/account/hands/requests/pending`, {
      headers: deps.headers || {},
      credentials: "include",
    });
    if (!resp.ok) return [];
    const rows = await resp.json();
    return Array.isArray(rows) ? rows.filter((r) => r.status === "pending") : [];
  }

  /** decision: "approve" | "deny" for approvals; answer: string for questions. */
  async function respond(req, choice, deps) {
    // A human step is completed by the signed-in person in the dashboard, never from here.
    if (req.kind === "human") return false;
    const body = { request_id: req.id, via: "extension" };
    if (req.kind === "approval") body.decision = choice;
    else body.answer = choice;
    const resp = await deps.fetch(`${deps.baseUrl}/api/account/hands/tasks/${req.task_id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(deps.headers || {}) },
      credentials: "include",
      body: JSON.stringify(body),
    });
    return resp.ok;
  }

  async function poll(deps) {
    const seen = deps.seen || (deps.seen = new Set());
    const pending = await fetchPending(deps);
    for (const req of pending) {
      if (seen.has(req.id)) continue;
      seen.add(req.id);
      const { title, message } = describe(req);
      await deps.notify(NOTIFY_PREFIX + req.id, {
        type: "basic",
        title,
        message,
        buttons: req.kind === "approval" ? [{ title: "Approve" }, { title: "Deny" }] : undefined,
        requireInteraction: true,
      }, req);
    }
    return pending;
  }

  /** Notification button 0 = Approve, 1 = Deny; a plain click opens the dashboard. */
  async function onButton(requestsById, notificationId, buttonIndex, deps) {
    if (!notificationId.startsWith(NOTIFY_PREFIX)) return false;
    const req = requestsById.get(notificationId.slice(NOTIFY_PREFIX.length));
    if (!req || req.kind !== "approval") return false;
    return respond(req, buttonIndex === 0 ? "approve" : "deny", deps);
  }

  /** Run control (#39858): action is "pause" | "resume" | "stop"; the API checks scope and owner. */
  async function control(taskId, action, deps) {
    if (!["pause", "resume", "stop"].includes(action)) return false;
    const resp = await deps.fetch(`${deps.baseUrl}/api/account/hands/tasks/${taskId}/${action}`, {
      method: "POST",
      headers: deps.headers || {},
      credentials: "include",
    });
    return resp.ok;
  }

  /** Steer a running task with a plain-text instruction; trusted user input server-side. */
  async function steer(taskId, instruction, deps) {
    const resp = await deps.fetch(`${deps.baseUrl}/api/account/hands/tasks/${taskId}/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(deps.headers || {}) },
      credentials: "include",
      body: JSON.stringify({ instruction }),
    });
    return resp.ok;
  }

  const api = { control, steer, POLL_ALARM, POLL_MINUTES, NOTIFY_PREFIX, describe, fetchPending, respond, poll, onButton };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AlterLabHandsApprovals = api;
})(typeof self !== "undefined" ? self : this);
