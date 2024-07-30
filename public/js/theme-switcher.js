/**
 * Theme Switcher
 * Manages color theme switching and persistence
 */

(function () {
  const THEME_KEY = "color-theme";
  const THEMES = {
    classic: "theme-classic",
    green: "theme-retro-green",
    sunset: "theme-sunset",
  };

  /**
   * Get the current theme from localStorage or default to classic
   *
   * Reads and writes are wrapped, because a browser in private mode or with
   * site data blocked throws on access rather than answering. This was the
   * only script here that reached for storage bare, so on such a browser it
   * threw on load and the theme dropdown was dead — while favorites.js
   * carried on.
   */
  function getCurrentTheme() {
    try {
      return localStorage.getItem(THEME_KEY) || "classic";
    } catch {
      return "classic";
    }
  }

  function rememberTheme(themeName) {
    try {
      localStorage.setItem(THEME_KEY, themeName);
    } catch {
      // The choice holds for this page view; it just will not be remembered.
    }
  }

  /**
   * Puts the theme's class on the root element, taking off whichever one was
   * there.
   *
   * The root element and not <body>, which is what this used to write to.
   * head.ejs loads this script synchronously in <head>, so <body> does not
   * exist yet when it runs — the class could only be attached once
   * DOMContentLoaded fired, by which point the document had already been laid
   * out and painted in the default palette. Every visitor on the green or
   * sunset theme therefore saw it flash past on every single navigation.
   *
   * document.documentElement exists from the moment parsing begins, so the
   * variables are in place before anything is painted. The theme rules in
   * style.css are selected as "html.theme-…" to match, which also beats the
   * ":root" the defaults live on — same element, one class more specific.
   */
  function setThemeClass(themeName) {
    const root = document.documentElement;

    Object.values(THEMES).forEach((themeClass) => {
      root.classList.remove(themeClass);
    });

    const themeClass = THEMES[themeName];

    if (themeClass) {
      root.classList.add(themeClass);
    }

    syncThemeColor();
  }

  /**
   * Point the browser chrome at whichever palette is now in force.
   *
   * views/head.ejs ships <meta name="theme-color"> as the classic blue on
   * every response and says why it cannot do better: the theme lives in
   * localStorage, so the server has no way to know it. This is the half that
   * does know, and it runs from setThemeClass so the two cannot drift — a
   * palette applied without the chrome following it is the flash of the wrong
   * colour that writing to documentElement was meant to end.
   *
   * The value is read back out of the cascade rather than kept in a table
   * here. Three hex codes copied into this file would be a second place to
   * change a colour, and the one that nothing renders from — so it would sit
   * wrong for as long as it took somebody to notice the address bar. Asking
   * for the custom property means style.css stays the only place a theme is
   * defined.
   *
   * getComputedStyle is accurate by the time this runs: the stylesheet <link>
   * precedes this script in <head>, and a browser blocks a synchronous script
   * on the stylesheets before it precisely so that reads like this one are not
   * answered from a half-built cascade.
   *
   * Both lookups are allowed to fail without taking the theme switch with
   * them. The meta is absent when the partial is rendered on its own — the
   * suite does that with a hand-written set of locals — and the property comes
   * back empty if the stylesheet did not load, in which case the markup's own
   * value is better than an empty one.
   */
  function syncThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');

    if (!meta) return;

    const background = getComputedStyle(document.documentElement)
      .getPropertyValue("--nc-bg")
      .trim();

    if (background) {
      meta.setAttribute("content", background);
    }
  }

  /**
   * Switch to a theme and remember the choice.
   */
  function applyTheme(themeName) {
    setThemeClass(themeName);

    rememberTheme(themeName);

    // Update active state in dropdown
    updateDropdownActiveState(themeName);
  }

  /**
   * Update the active state visual indicator in the dropdown
   */
  function updateDropdownActiveState(activeTheme) {
    const themeItems = document.querySelectorAll(".theme-option");
    themeItems.forEach((item) => {
      const themeName = item.dataset.theme;
      if (themeName === activeTheme) {
        item.classList.add("active");
      } else {
        item.classList.remove("active");
      }
    });
  }

  /**
   * Apply the stored theme immediately when the script loads.
   *
   * No waiting for the document any more: the root element this writes to is
   * already there, which is the whole point of writing to it. The dropdown's
   * active state is left to initEventListeners below, which does need the DOM.
   *
   * This also stops re-writing the stored value on every page load — it used
   * to go through applyTheme, which remembers.
   */
  function applyInitialTheme() {
    setThemeClass(getCurrentTheme());
  }

  /**
   * Initialize theme switcher event listeners
   */
  function initEventListeners() {
    const themeItems = document.querySelectorAll(".theme-option");

    themeItems.forEach((item) => {
      item.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        applyTheme(this.dataset.theme);
      });
    });

    // Update initial active state
    const currentTheme = getCurrentTheme();
    updateDropdownActiveState(currentTheme);

    initDropdownState();
  }

  /**
   * Keeps aria-expanded on the toggle honest. The menu itself is opened by
   * the stylesheet — on :hover and on :focus-within — so this only reports
   * what the stylesheet is doing, and closes the menu on Escape by dropping
   * focus out of it.
   */
  function initDropdownState() {
    document.querySelectorAll(".dropdown").forEach((dropdown) => {
      const toggle = dropdown.querySelector(".dropdown-toggle");

      if (!toggle) return;

      const setExpanded = (open) =>
        toggle.setAttribute("aria-expanded", open ? "true" : "false");

      dropdown.addEventListener("focusin", () => setExpanded(true));
      dropdown.addEventListener("focusout", (event) => {
        if (!dropdown.contains(event.relatedTarget)) setExpanded(false);
      });
      dropdown.addEventListener("mouseenter", () => setExpanded(true));
      dropdown.addEventListener("mouseleave", () => {
        if (!dropdown.contains(document.activeElement)) setExpanded(false);
      });
      dropdown.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;

        if (dropdown.contains(document.activeElement)) {
          document.activeElement.blur();
        }

        setExpanded(false);
      });
    });
  }

  // Apply theme immediately
  applyInitialTheme();

  // Set up event listeners when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initEventListeners);
  } else {
    // DOM is already loaded
    initEventListeners();
  }

  // Export for external use if needed
  window.ThemeSwitcher = {
    applyTheme,
    getCurrentTheme,
    initDropdownState,
    THEMES,
  };
})();
