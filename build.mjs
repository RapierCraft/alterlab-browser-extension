#!/usr/bin/env node
/**
 * AlterLab Connect — build script.
 *
 * The two browser trees (chrome-extension/, firefox-extension/) are mirrored
 * verbatim from the AlterLab monorepo (tools/chrome-extension, tools/firefox-extension)
 * by the monorepo's ecosystem sync. This script only packages them:
 *
 *   - copies the tree, leaving out tests, store art and icon generators
 *   - stamps the version into manifest.json when --version is given
 *   - Firefox: merges build/firefox-overlay.json (AMO data_collection_permissions)
 *   - writes dist/<browser>/ and dist/alterlab-connect-<browser>.zip
 *
 * Usage:
 *   node build.mjs [chrome|firefox ...] [--version X.Y.Z]
 */
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");
const BROWSERS = ["chrome", "firefox"];

// Paths (relative to a browser tree) that are not part of the shipped extension.
const NOT_SHIPPED = ["tests", "store-assets", join("icons", "generate-icons.html")];

/** Minimal dependency-free zip writer (deflate, fixed timestamp => reproducible archives). */
function zipDir(dir, zipPath) {
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d).sort()) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e !== ".DS_Store" && !e.endsWith(".map")) files.push(full);
    }
  })(dir);

  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  const parts = [], central = [];
  let offset = 0;
  for (const full of files) {
    const name = Buffer.from(relative(dir, full).split(sep).join("/"));
    const raw = readFileSync(full);
    const data = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10); cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(cen, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(zipPath, Buffer.concat([...parts, ...central, end]));
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
    out[k] = isObj(out[k]) && isObj(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function build(browser, version) {
  const src = join(ROOT, `${browser}-extension`);
  if (!existsSync(join(src, "manifest.json"))) {
    throw new Error(`${browser}-extension/manifest.json not found`);
  }
  const out = join(DIST, browser);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const skip = new Set(NOT_SHIPPED.map((p) => join(src, p)));
  cpSync(src, out, { recursive: true, filter: (p) => !skip.has(p) });

  let manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  if (browser === "firefox") {
    manifest = deepMerge(
      manifest,
      JSON.parse(readFileSync(join(ROOT, "build", "firefox-overlay.json"), "utf8")),
    );
  }
  if (version) manifest.version = version;
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const zip = join(DIST, `alterlab-connect-${browser}.zip`);
  rmSync(zip, { force: true });
  zipDir(out, zip);
  const kb = (statSync(zip).size / 1024).toFixed(1);
  console.log(`  ${browser}: v${manifest.version} -> dist/${browser}/ + ${zip.split(sep).pop()} (${kb} KB)`);
  return { dir: out, zip, manifest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const vi = args.indexOf("--version");
  let version;
  if (vi !== -1) {
    version = args[vi + 1];
    args.splice(vi, 2);
    if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
      console.error(`ERROR: --version needs MAJOR.MINOR.PATCH, got "${version}"`);
      process.exit(1);
    }
  }
  const targets = args.length ? args : BROWSERS;
  for (const t of targets) {
    if (!BROWSERS.includes(t)) {
      console.error(`ERROR: unknown target "${t}" (chrome|firefox)`);
      process.exit(1);
    }
  }
  console.log("AlterLab Connect build");
  mkdirSync(DIST, { recursive: true });
  for (const t of targets) build(t, version);
}
