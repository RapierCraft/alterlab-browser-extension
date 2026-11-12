import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

for (const ext of ["chrome-extension", "firefox-extension"]) {
  for (const file of ["shared.js", "sidepanel.js", "background.js"]) {
    const src = readFileSync(new URL(`${ext}/${file}`, root), "utf8");
    test(`${ext}/${file} sends no device identifier`, () => {
      assert.ok(!/X-Device-Id/i.test(src));
      assert.ok(!/getDeviceId/.test(src));
      assert.ok(!/\bdeviceId\b/.test(src));
      const refs = src.match(/alterlabDeviceId/g) || [];
      assert.equal(refs.length, file === "background.js" ? 1 : 0);
    });
  }
  test(`${ext} erases legacy id on update`, () => {
    const src = readFileSync(new URL(`${ext}/background.js`, root), "utf8");
    assert.match(src, /storage\.local\.remove\("alterlabDeviceId"\)/);
  });
}
