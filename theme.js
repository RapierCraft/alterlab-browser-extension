/**
 * AlterLab Connect — Theme Manager
 *
 * Handles dark/light theme toggling with persistence via browser.storage.local.
 * Dark mode is the default. The active theme is applied via [data-theme] on <html>.
 *
 * Usage:
 *   <script src="theme.js"></script>
 *   <button class="al-theme-toggle" id="themeToggle" role="switch"
 *           aria-checked="false" aria-label="Toggle light mode"></button>
 *
 *   Theme is automatically applied on load. Toggle via AlterLabTheme.toggle()
 *   or by clicking any element with id="themeToggle".
 */

// eslint-disable-next-line no-unused-vars
const AlterLabTheme = (() => {
  const STORAGE_KEY = "alterlab-theme";
  const DARK = "dark";
  const LIGHT = "light";

  /**
   * Apply theme to document and update toggle UI.
   * @param {"dark"|"light"} theme
   */
  function apply(theme) {
    const root = document.documentElement;

    if (theme === LIGHT) {
      root.setAttribute("data-theme", LIGHT);
    } else {
      root.removeAttribute("data-theme");
    }

    // Update all toggle buttons
    document.querySelectorAll(".al-theme-toggle").forEach((btn) => {
      btn.setAttribute("aria-checked", theme === LIGHT ? "true" : "false");
    });
  }

  /**
   * Read saved theme from browser.storage.local.
   * Falls back to "dark" if nothing is saved (dark is default).
   * @returns {Promise<"dark"|"light">}
   */
  async function load() {
    try {
      if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
        const result = await browser.storage.local.get(STORAGE_KEY);
        return result[STORAGE_KEY] === LIGHT ? LIGHT : DARK;
      }
    } catch (_) {
      // Not in extension context — fall through
    }

    // Fallback: check localStorage (for options page or non-extension contexts)
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === LIGHT) return LIGHT;
    } catch (_) {
      // localStorage blocked
    }

    return DARK;
  }

  /**
   * Persist theme choice.
   * @param {"dark"|"light"} theme
   */
  async function save(theme) {
    try {
      if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
        await browser.storage.local.set({ [STORAGE_KEY]: theme });
      }
    } catch (_) {
      // Not in extension context
    }

    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (_) {
      // localStorage blocked
    }
  }

  /**
   * Get the current active theme.
   * @returns {"dark"|"light"}
   */
  function current() {
    return document.documentElement.getAttribute("data-theme") === LIGHT
      ? LIGHT
      : DARK;
  }

  /**
   * Toggle between dark and light themes.
   * @returns {"dark"|"light"} The newly applied theme.
   */
  function toggle() {
    const next = current() === DARK ? LIGHT : DARK;
    apply(next);
    save(next);
    return next;
  }

  /**
   * Initialize: load saved preference, apply, and bind toggle buttons.
   * Call this after DOM is ready.
   */
  async function init() {
    const theme = await load();
    apply(theme);

    // Bind click handlers on any .al-theme-toggle elements
    document.querySelectorAll(".al-theme-toggle").forEach((btn) => {
      btn.addEventListener("click", () => toggle());

      // Keyboard accessibility: Space/Enter to toggle
      btn.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          toggle();
        }
      });
    });
  }

  // Auto-init when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Public API
  return { init, toggle, current, apply };
})();
