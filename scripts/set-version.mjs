#!/usr/bin/env node
// Stamp a release version into every source manifest: node scripts/set-version.mjs 2.2.0
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error(`usage: set-version.mjs MAJOR.MINOR.PATCH (got "${version}")`);
  process.exit(1);
}
for (const f of ["chrome-extension/manifest.json", "firefox-extension/manifest.json", "package.json"]) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.version = version;
  writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  console.log(`${f} -> ${version}`);
}
