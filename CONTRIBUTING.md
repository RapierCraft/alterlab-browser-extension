# Contributing to AlterLab Connect

Thank you for your interest in contributing to AlterLab Connect — the open-source browser extension that powers cookie capture and authenticated scraping for [AlterLab](https://alterlab.io).

AlterLab Connect works in both Chrome (and Chromium-based browsers) and Firefox. All contributions are welcome, from bug fixes and performance improvements to new features and documentation updates.

Please read this guide before opening a pull request. It will save you and the maintainers time.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Environment](#development-environment)
- [Building the Extension](#building-the-extension)
- [Loading the Extension for Testing](#loading-the-extension-for-testing)
- [Code Style](#code-style)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Issues](#reporting-issues)
- [AlterLab Account for Testing](#alterlab-account-for-testing)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it. Please report unacceptable behavior to support@alterlab.io.

---

## Getting Started

**Prerequisites:**

- Node.js 18 or later
- npm 9 or later
- `zip` available on your PATH (used by the build script to produce distributable archives)

**Fork and clone:**

```bash
git clone https://github.com/YOUR_USERNAME/alterlab-browser-extension.git
cd alterlab-browser-extension
npm install
```

---

## Development Environment

The project has no bundler — the source files are plain JavaScript and are copied directly into the build output by `build.mjs`. There is no transpilation step.

The build script (`build.mjs`) reads `manifest.json` (base), merges it with `manifest.chrome.json` or `manifest.firefox.json` (browser-specific overrides), copies all source files, and writes the merged build into `dist/chrome/` or `dist/firefox/`.

---

## Building the Extension

All build commands use Node directly — no global install is needed.

| Command | Output |
|---|---|
| `npm run build` | Builds both Chrome and Firefox into `dist/` |
| `npm run build:chrome` | Builds Chrome only into `dist/chrome/` |
| `npm run build:firefox` | Builds Firefox only into `dist/firefox/` |
| `npm run clean` | Removes the entire `dist/` directory |

The build script also creates zip archives (`dist/alterlab-connect-chrome.zip`, `dist/alterlab-connect-firefox.zip`) suitable for store submission.

**Example:**

```bash
npm run build
# Output:
#   Built chrome  -> dist/chrome/
#   Built firefox -> dist/firefox/
#   Verified: Chrome and Firefox builds have identical file lists.
```

---

## Loading the Extension for Testing

After building, load the unpacked extension directly from the `dist/` directory. You do not need to publish to any store for local testing.

**Chrome / Chromium / Edge:**

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable "Developer mode" (toggle in the top right).
3. Click "Load unpacked".
4. Select the `dist/chrome/` directory.

**Firefox:**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on".
3. Select any file inside `dist/firefox/` (e.g., `manifest.json`).

The extension will appear in your toolbar. After making source changes, run `npm run build` again and click the refresh icon on the extensions page to reload.

---

## Code Style

The codebase is plain JavaScript (ES modules where applicable). Please follow these conventions when contributing:

- **No build tools or transpilers.** Do not introduce Webpack, Rollup, Babel, TypeScript, or similar tools. The project is intentionally dependency-light.
- **JSDoc comments** for all exported functions and non-obvious logic. See existing files (`popup.js`, `shared.js`, `background.js`) for examples.
- **`const` by default.** Use `let` only when reassignment is required. Never use `var`.
- **Async/await** for all asynchronous code. Do not use raw `.then()` chains.
- **Descriptive names.** Prefer `isAuthenticated` over `auth`, `cookieList` over `cl`.
- **2-space indentation**, Unix line endings (`\n`), no trailing whitespace.
- **No third-party runtime dependencies.** `devDependencies` (Playwright) are fine for testing. Do not add packages that ship inside the extension.

There is no linter configured in this repository. Please review your changes manually before submitting.

---

## Submitting a Pull Request

1. **Fork** the repository and create a branch from `main`:

   ```bash
   git checkout -b fix/describe-your-fix
   # or
   git checkout -b feat/describe-your-feature
   ```

2. **Make your changes.** Keep each branch focused on a single concern.

3. **Build and verify** both targets before pushing:

   ```bash
   npm run build
   ```

   Confirm the build completes without errors and that both `dist/chrome/` and `dist/firefox/` are populated correctly.

4. **Test in at least one browser** (Chrome and Firefox preferred — see [Loading the Extension for Testing](#loading-the-extension-for-testing)).

5. **Push your branch** and open a pull request against `main` on this repository.

6. **Fill in the pull request template.** Describe what the PR does, how to test it, and confirm both browser targets work.

Pull requests that touch cookie handling, API communication, or permissions will be reviewed with extra care for security implications. Please document your reasoning in those cases.

---

## Reporting Issues

Before opening an issue, please:

- Check the [existing issues](https://github.com/RapierCraftStudios/alterlab-browser-extension/issues) to avoid duplicates.
- Confirm you are running the latest version of the extension.

Use the issue templates provided:

- **Bug report** — for unexpected behavior or errors.
- **Feature request** — for new capabilities or improvements.

Include your browser name and version, the extension version (visible on the extensions page), and your operating system. The more detail you provide, the faster it can be investigated.

---

## AlterLab Account for Testing

Some functionality (cookie push, authenticated scraping) requires a live AlterLab account. You can create a free account at:

[https://app.alterlab.io/signin](https://app.alterlab.io/signin)

Once signed in, generate an API key in your dashboard settings and configure the extension with that key to test the full BYOS (Bring Your Own Session) workflow.
