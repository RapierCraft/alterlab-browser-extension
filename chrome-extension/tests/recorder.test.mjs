import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const R = require("../recorder.js");
const URL0 = "https://shop.example.com/";

function flow(session) {
  const ev = (kind, target, url = URL0 + "search") => ({ kind, target, url, tabId: 7 });
  session.add(ev("navigate"));
  session.add(ev("input", { tag: "INPUT", testid: "q", placeholder: "Search term" }));
  session.add(ev("click", { tag: "BUTTON", id: "go" }));
  session.add(ev("input", { tag: "INPUT", type: "password", name: "pw" }));
  session.add(ev("change", { tag: "SELECT", name: "sort" }));
}

test("5-step flow becomes parameters and secrets, never values", () => {
  const s = R.createSession({ tabId: 7, startUrl: URL0 });
  flow(s);
  const draft = R.buildRecipeDraft(s, "Search");
  assert.equal(draft.payload.steps.length, 5);
  assert.deepEqual(draft.parameters, ["search_term", "sort"]);
  assert.deepEqual(draft.secrets, ["pw"]);
  assert.equal(draft.payload.steps[1].selector, '[data-testid="q"]');
  for (const step of draft.payload.steps) assert.equal("value" in step, false);
});

test("events carrying a value are not stored", () => {
  const s = R.createSession({ tabId: 7, startUrl: URL0 });
  s.add({ kind: "input", tabId: 7, url: URL0, value: "hunter2", target: { tag: "INPUT", name: "q", value: "hunter2" } });
  assert.equal(JSON.stringify(s.toJSON()).includes("hunter2"), false);
});

test("scoped to one tab and origin; stops on stop()", () => {
  const s = R.createSession({ tabId: 7, startUrl: URL0 });
  assert.equal(s.add({ kind: "click", tabId: 8, url: URL0, target: { tag: "A", id: "x" } }), false);
  assert.equal(s.add({ kind: "click", tabId: 7, url: "https://evil.example.org/", target: { tag: "A", id: "x" } }), false);
  s.stop();
  assert.equal(s.add({ kind: "click", tabId: 7, url: URL0, target: { tag: "A", id: "x" } }), false);
});

test("sensitive detection and rename", () => {
  assert.equal(R.isSensitive({ type: "password" }), true);
  assert.equal(R.isSensitive({ autocomplete: "cc-number" }), true);
  assert.equal(R.isSensitive({ name: "city" }), false);
  const steps = R.renameField([{ type: "type", selector: "#a", param: "x" }], "x", "Search Term");
  assert.equal(steps[0].param, "search_term");
  assert.throws(() => R.renameField(steps, "search_term", "!!"));
});

test("content script shows an indicator and never reads values", () => {
  const src = readFileSync(new URL("../recorder-content.js", import.meta.url), "utf8");
  assert.match(src, /recording this tab/);
  assert.equal(/\.value\b/.test(src), false);
});
