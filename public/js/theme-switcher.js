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
      const isActive = themeName === activeTheme;

      item.classList.toggle("active", isActive);

      // The class is a colour. Each option carries role="menuitemradio"
      // (views/navbar.ejs), and the state that role promises is aria-checked
      // — without it a screen reader announced three radio items and never
      // said which one was in force.
      item.setAttribute("aria-checked", isActive ? "true" : "false");

      // Roving tabindex: one stop for the whole group, on the choice that is
      // in force, and the arrow keys move within it. That is the model
      // role="menu" promises, and it is why the markup carries no tabindex of
      // its own — with the script blocked the three buttons stay natively
      // focusable and the :focus-within rule still opens the menu for them.
      item.setAttribute("tabindex", isActive ? "0" : "-1");
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
   * The menu's open/close model.
   *
   * The stylesheet opens the menu on :hover and on :focus-within, and that
   * stays — it is what keeps the three themes reachable if this script is
   * blocked. What it cannot do is open on a tap (a touch screen fires no
   * hover), report state, or close on Escape without throwing focus away, so
   * the toggle gets a real click handler and the menu an "open" class
   * (.dropdown.open .dropdown-menu in public/css/style.css).
   *
   * The keyboard model is the one role="menu" promises and never had:
   * ArrowDown/ArrowUp wrap through the items, Home/End jump to the ends,
   * Escape closes and hands focus back to the toggle, and a click anywhere
   * else closes.
   */
  function initDropdownState() {
    document.querySelectorAll(".dropdown").forEach((dropdown) => {
      const toggle = dropdown.querySelector(".dropdown-toggle");

      if (!toggle) return;

      const menu = dropdown.querySelector(".dropdown-menu");

      // Tells the stylesheet that this script is in charge of the menu now.
      // The :focus-within rule is scoped to dropdowns *without* this class
      // (see style.css): it is the no-JavaScript fallback, and while it
      // applies, focus on the toggle alone opens the menu — which would make
      // Escape unable to close it without also throwing focus away, since
      // closing hands focus back to the toggle.
      dropdown.classList.add("dropdown-js");

      const isOpen = () => dropdown.classList.contains("open");

      const setExpanded = (open) =>
        toggle.setAttribute("aria-expanded", open ? "true" : "false");

      const items = () =>
        Array.from(dropdown.querySelectorAll(".dropdown-item"));

      /**
       * Focus is moved with tabindex="0" written first: an element with
       * tabindex="-1" takes focus programmatically, but leaving the group
       * without a tab stop would strand the next Tab press.
       */
      const focusItem = (index) => {
        const all = items();

        if (all.length === 0) return;

        const wrapped = (index + all.length) % all.length;

        all.forEach((item, i) =>
          item.setAttribute("tabindex", i === wrapped ? "0" : "-1"),
        );
        all[wrapped].focus();
      };

      const open = () => {
        dropdown.classList.add("open");
        setExpanded(true);
      };

      const close = (returnFocus) => {
        dropdown.classList.remove("open");
        setExpanded(false);

        if (returnFocus) {
          toggle.focus();
        } else if (dropdown.contains(document.activeElement)) {
          document.activeElement.blur();
        }
      };

      toggle.addEventListener("click", () => {
        if (isOpen()) {
          close(false);
        } else {
          open();
        }
      });

      // Focus inside the menu, not focus anywhere in the dropdown: the menu
      // is only reachable while it is open, so this reports a menu that is
      // genuinely on screen. Focus landing on the toggle no longer says
      // "open" — see the .dropdown-js note above.
      dropdown.addEventListener("focusin", (event) => {
        if (!menu || menu.contains(event.target)) setExpanded(true);
      });
      dropdown.addEventListener("focusout", (event) => {
        if (!dropdown.contains(event.relatedTarget)) {
          dropdown.classList.remove("open");
          setExpanded(false);
        }
      });
      // Only while the menu is not held open by a click, or moving the
      // pointer away would report a menu that is still on screen as closed.
      dropdown.addEventListener("mouseenter", () => {
        if (!isOpen()) setExpanded(true);
      });
      dropdown.addEventListener("mouseleave", () => {
        if (isOpen()) return;

        if (!dropdown.contains(document.activeElement)) setExpanded(false);
      });

      dropdown.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          close(true);
          return;
        }

        const all = items();
        const current = all.indexOf(document.activeElement);

        switch (event.key) {
          case "ArrowDown":
            event.preventDefault();
            open();
            focusItem(current + 1);
            break;
          case "ArrowUp":
            event.preventDefault();
            open();
            focusItem(current < 0 ? -1 : current - 1);
            break;
          case "Home":
            if (current < 0) return;
            event.preventDefault();
            focusItem(0);
            break;
          case "End":
            if (current < 0) return;
            event.preventDefault();
            focusItem(all.length - 1);
            break;
          default:
            break;
        }
      });
    });

    // One listener for the page, not one per dropdown: a click that lands
    // outside every menu closes all of them.
    if (!document.documentElement.dataset.dropdownOutsideBound) {
      document.documentElement.dataset.dropdownOutsideBound = "true";

      document.addEventListener("click", (event) => {
        document.querySelectorAll(".dropdown.open").forEach((dropdown) => {
          if (dropdown.contains(event.target)) return;

          dropdown.classList.remove("open");
          dropdown
            .querySelector(".dropdown-toggle")
            ?.setAttribute("aria-expanded", "false");
        });
      });
    }
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
