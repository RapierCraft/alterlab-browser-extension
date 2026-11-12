import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const H = require("../hands-approvals.js");

const approval = {
  id: "r1", task_id: "t1", kind: "approval", status: "pending", site: "example.com",
  preview: { actions: [{ type: "click", selector: "#apply" }] },
};
const question = { id: "r2", task_id: "t1", kind: "question", status: "pending", prompt: "Which?" };

function deps(rows, calls = [], notes = []) {
  return {
    baseUrl: "https://api.test",
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      return { ok: true, json: async () => rows };
    },
    notify: async (id, options, req) => notes.push({ id, options, req }),
  };
}

test("chrome and firefox modules are identical", () => {
  assert.equal(
    readFileSync(new URL("../hands-approvals.js", import.meta.url), "utf8"),
    readFileSync(new URL("../../firefox-extension/hands-approvals.js", import.meta.url), "utf8"),
  );
});

test("poll notifies each pending request once, approvals with Approve/Deny", async () => {
  const notes = [];
  const d = deps([approval, question, { ...question, id: "r3", status: "answered" }], [], notes);
  await H.poll(d);
  await H.poll(d);
  assert.equal(notes.length, 2);
  assert.match(notes[0].options.message, /click #apply/);
  assert.equal(notes[0].options.buttons.length, 2);
  assert.equal(notes[1].options.buttons, undefined);
});

test("approve button posts the decision via extension", async () => {
  const calls = [];
  const ok = await H.onButton(new Map([["r1", approval]]), H.NOTIFY_PREFIX + "r1", 0, deps([], calls));
  assert.equal(ok, true);
  assert.equal(calls[0].url, "https://api.test/api/account/hands/tasks/t1/answer");
  assert.deepEqual(JSON.parse(calls[0].init.body), { request_id: "r1", via: "extension", decision: "approve" });
});

test("deny button and question answers", async () => {
  const calls = [];
  await H.onButton(new Map([["r1", approval]]), H.NOTIFY_PREFIX + "r1", 1, deps([], calls));
  assert.equal(JSON.parse(calls[0].init.body).decision, "deny");
  await H.respond(question, "A", deps([], calls));
  assert.deepEqual(JSON.parse(calls[1].init.body), { request_id: "r2", via: "extension", answer: "A" });
});

test("foreign notification ids are ignored", async () => {
  assert.equal(await H.onButton(new Map(), "other", 0, deps([])), false);
});

test("human step is announced without buttons and never answered from the extension", async () => {
  const human = {
    id: "r3", task_id: "t1", kind: "human", status: "pending", prompt: "Record a 60s video",
    preview: { reason: "founder_video", deep_link: "/dashboard/hands/human?task=t1&request=r3" },
  };
  const calls = [], notes = [];
  await H.poll(deps([human], calls, notes));
  assert.match(notes[0].options.title, /founder video/);
  assert.equal(notes[0].options.buttons, undefined);
  assert.equal(await H.respond(human, "done", deps([], calls)), false);
  assert.equal(calls.filter((c) => c.url.endsWith("/answer")).length, 0);
});
