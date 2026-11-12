import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const H = require("../hands-audit.js");

function deps(body, { ok = true, apiKey = "k1", calls = [] } = {}) {
  return {
    getConfig: async () => ({ apiUrl: "https://api.test", apiKey }),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok, json: async () => body };
    },
  };
}

test("chrome and firefox modules and activity page are identical", () => {
  for (const f of ["hands-audit.js", "activity.js", "activity.html"]) {
    assert.equal(
      readFileSync(new URL(`../${f}`, import.meta.url), "utf8"),
      readFileSync(new URL(`../../firefox-extension/${f}`, import.meta.url), "utf8"),
    );
  }
});

test("a non-OK response or a missing key yields no alerts", async () => {
  assert.deepEqual(await H.fetchAlerts(deps({}, { ok: false })), []);
  assert.deepEqual(await H.fetchAlerts(deps({ alerts: [{ writes_paused: true }] }, { apiKey: "" })), []);
});

test("fetchAlerts keeps only alerts that still pause writes", async () => {
  const alerts = await H.fetchAlerts(
    deps({
      alerts: [
        { site: "a.com", signal: "forced_logout", writes_paused: true, cooldown_until: "u" },
        { site: "b.com", signal: "captcha", writes_paused: false },
      ],
    }),
  );
  assert.equal(alerts.length, 1);
  assert.equal(H.describeAlert(alerts[0]), "Writes on a.com are paused until u (forced_logout).");
});

test("fetchAudit requests /hands/audit with the API key and maps rows", async () => {
  const calls = [];
  const rows = await H.fetchAudit(
    deps(
      { entries: [{ created_at: "t", site: "a.com", action_type: "click", outcome: "ok", approval_ref: "ap1" },
                  { created_at: "t2", site: "b.com", action_type: "type", outcome: "blocked" }] },
      { calls },
    ),
    25,
  );
  assert.equal(calls[0].url, "https://api.test/api/v1/hands/audit?limit=25");
  assert.equal(calls[0].init.headers["X-API-Key"], "k1");
  assert.deepEqual(rows[0], { at: "t", site: "a.com", action: "click", outcome: "ok", approvalRef: "ap1" });
  assert.equal(rows[1].approvalRef, "");
});

test("fetchAudit returns no rows on a non-OK response", async () => {
  assert.deepEqual(await H.fetchAudit(deps({}, { ok: false })), []);
});
