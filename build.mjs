#!/usr/bin/env node

/**
 * AlterLab Connect — Multi-Browser Build Script
 *
 * Produces browser-specific extension builds by merging a base manifest
 * with browser-specific overrides, copying all shared files, and creating
 * distributable zip archives.
 *
 * Usage:
 *   node build.mjs chrome       # Build Chrome only
 *   node build.mjs firefox      # Build Firefox only
 *   node build.mjs              # Build both (default)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, cpSync, rmSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { execSync } from "node:child_process";

const ROOT = dirname(new URL(import.meta.url).pathname);
const DIST = join(ROOT, "dist");

// Files that are part of the build system or store assets — not extension source
const EXCLUDED = new Set([
  "manifest.chrome.json",
  "manifest.firefox.json",
  "build.mjs",
  "package.json",
  "package-lock.json",
  "node_modules",
  ".gitignore",
  ".git",
  "dist",
  "store-assets",
  "tests",
  "playwright.config.mjs",
  "test-results",
  "playwright-report",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep-merge two objects. Arrays in the override are concatenated with the
 * base (deduped). Objects are recursively merged. Scalars from override win.
 */
function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      key in result &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key]) &&
      typeof override[key] === "object" &&
      !Array.isArray(override[key])
    ) {
      result[key] = deepMerge(result[key], override[key]);
    } else if (Array.isArray(result[key]) && Array.isArray(override[key])) {
      // Concatenate and deduplicate
      result[key] = [...new Set([...result[key], ...override[key]])];
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

/**
 * Collect all extension source files (relative paths) from ROOT,
 * excluding build artifacts and non-extension files.
 */
function collectSourceFiles() {
  const files = [];

  function walk(dir, rel) {
    for (const entry of readdirSync(dir)) {
      if (rel === "" && EXCLUDED.has(entry)) continue;
      const full = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full, relPath);
      } else {
        files.push(relPath);
      }
    }
  }

  walk(ROOT, "");
  return files;
}

/**
 * Build a single browser variant.
 */
function buildVariant(browser) {
  const overridePath = join(ROOT, `manifest.${browser}.json`);
  if (!existsSync(overridePath)) {
    console.error(`ERROR: manifest.${browser}.json not found`);
    process.exit(1);
  }

  const base = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf-8"));
  const override = JSON.parse(readFileSync(overridePath, "utf-8"));
  const merged = deepMerge(base, override);

  const outDir = join(DIST, browser);

  // Clean previous build
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true });
  }
  mkdirSync(outDir, { recursive: true });

  // Copy shared source files (excluding manifest.json — we write the merged one)
  const sources = collectSourceFiles().filter((f) => f !== "manifest.json");
  for (const relPath of sources) {
    const src = join(ROOT, relPath);
    const dest = join(outDir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }

  // Write merged manifest
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(merged, null, 2) + "\n");

  console.log(`  Built ${browser} → dist/${browser}/`);
  console.log(`    manifest keys: ${Object.keys(merged).join(", ")}`);

  // Create zip archive
  const zipName = `alterlab-connect-${browser}.zip`;
  const zipPath = join(DIST, zipName);
  if (existsSync(zipPath)) rmSync(zipPath);

  // Use system zip (available on all CI and dev machines)
  execSync(`cd "${outDir}" && zip -r "${zipPath}" .`, { stdio: "pipe" });

  const zipSize = statSync(zipPath).size;
  console.log(`    zip: ${zipName} (${(zipSize / 1024).toFixed(1)} KB)`);

  return { dir: outDir, zip: zipPath, manifest: merged };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const targets = args.length > 0 ? args : ["chrome", "firefox"];
const validTargets = ["chrome", "firefox"];

for (const t of targets) {
  if (!validTargets.includes(t)) {
    console.error(`ERROR: Unknown target "${t}". Valid: ${validTargets.join(", ")}`);
    process.exit(1);
  }
}

console.log(`AlterLab Connect — Building: ${targets.join(", ")}\n`);

// Ensure dist/ exists
mkdirSync(DIST, { recursive: true });

const results = {};
for (const target of targets) {
  results[target] = buildVariant(target);
}

// Verification: compare file lists (excluding manifest.json which intentionally differs)
if (results.chrome && results.firefox) {
  const chromeFiles = collectFilesInDir(results.chrome.dir).sort();
  const firefoxFiles = collectFilesInDir(results.firefox.dir).sort();

  const chromeSet = new Set(chromeFiles);
  const firefoxSet = new Set(firefoxFiles);

  const chromeOnly = chromeFiles.filter((f) => !firefoxSet.has(f));
  const firefoxOnly = firefoxFiles.filter((f) => !chromeSet.has(f));

  if (chromeOnly.length > 0 || firefoxOnly.length > 0) {
    console.warn("\n  WARNING: File lists differ between builds:");
    if (chromeOnly.length) console.warn(`    Chrome only: ${chromeOnly.join(", ")}`);
    if (firefoxOnly.length) console.warn(`    Firefox only: ${firefoxOnly.join(", ")}`);
  } else {
    console.log("\n  Verified: Chrome and Firefox builds have identical file lists.");
  }
}

console.log("\nDone.");

/**
 * List all files in a directory (relative paths).
 */
function collectFilesInDir(dir) {
  const files = [];
  function walk(d, rel) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        walk(full, relPath);
      } else {
        files.push(relPath);
      }
    }
  }
  walk(dir, "");
  return files;
}
