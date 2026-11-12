// Entry point so `node --test <this directory>` runs every sibling *.test.mjs
// (Node 22 resolves a directory argument to its index.js). CI uses globs.
const { readdirSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

(async () => {
  for (const f of readdirSync(__dirname).sort()) {
    if (f.endsWith(".test.mjs"))
      await import(pathToFileURL(path.join(__dirname, f)).href);
  }
})();
