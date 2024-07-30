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
   */
  function getCurrentTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    return saved || "classic";
  }

  /**
   * Apply theme to body element
   */
  function applyTheme(themeName) {
    const body = document.body;

    // Remove all theme classes
    Object.values(THEMES).forEach((themeClass) => {
      body.classList.remove(themeClass);
    });

    // Add the selected theme class
    const themeClass = THEMES[themeName];
    if (themeClass) {
      body.classList.add(themeClass);
      console.log("Theme applied:", themeName, themeClass); // Debug
    }

    // Save to localStorage
    localStorage.setItem(THEME_KEY, themeName);

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
   * Apply theme immediately when script loads
   */
  function applyInitialTheme() {
    // Wait for body to exist
    if (!document.body) {
      // If body doesn't exist yet, wait for DOMContentLoaded
      document.addEventListener("DOMContentLoaded", function () {
        const currentTheme = getCurrentTheme();
        applyTheme(currentTheme);
      });
      return;
    }

    const currentTheme = getCurrentTheme();
    const body = document.body;

    // Remove all theme classes
    Object.values(THEMES).forEach((themeClass) => {
      body.classList.remove(themeClass);
    });

    // Add the selected theme class
    const themeClass = THEMES[currentTheme];
    if (themeClass) {
      body.classList.add(themeClass);
    }
  }

  /**
   * Initialize theme switcher event listeners
   */
  function initEventListeners() {
    const themeItems = document.querySelectorAll(".theme-option");
    console.log("Found theme items:", themeItems.length); // Debug

    themeItems.forEach((item) => {
      item.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        const themeName = this.dataset.theme;
        console.log("Theme clicked:", themeName); // Debug
        applyTheme(themeName);
      });
    });

    // Update initial active state
    const currentTheme = getCurrentTheme();
    updateDropdownActiveState(currentTheme);
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
    THEMES,
  };
})();
