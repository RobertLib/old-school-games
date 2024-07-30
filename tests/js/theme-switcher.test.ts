/**
 * @vitest-environment jsdom
 */
import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scriptContent = readFileSync(
  path.resolve(__dirname, "../../public/js/theme-switcher.js"),
  "utf-8",
);

// Replace Node.js 25's non-functional localStorage with a proper in-memory mock
const _lsStore = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => _lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => _lsStore.set(k, String(v)),
    removeItem: (k: string) => _lsStore.delete(k),
    clear: () => _lsStore.clear(),
    get length() {
      return _lsStore.size;
    },
    key: (n: number) => [..._lsStore.keys()][n] ?? null,
  },
});

beforeAll(() => {
  // Indirect eval runs code in the global scope so window.ThemeSwitcher is set
  // eslint-disable-next-line no-eval
  (0, eval)(scriptContent);
});

// The theme class lives on <html>, not <body>: head.ejs loads the script
// before <body> exists, so that is the only element it can write to without
// waiting for the document (and painting the default palette first).
const root = document.documentElement;

beforeEach(() => {
  _lsStore.clear();
  root.className = "";
  document.body.className = "";
  // Remove active class from any lingering theme-option elements
  document.body.innerHTML = "";
});

declare const window: Window &
  typeof globalThis & {
    ThemeSwitcher: {
      applyTheme: (name: string) => void;
      getCurrentTheme: () => string;
      THEMES: Record<string, string>;
    };
  };

describe("theme-switcher.js — exports", () => {
  it("exposes window.ThemeSwitcher", () => {
    expect(window.ThemeSwitcher).toBeDefined();
  });

  it("exports getCurrentTheme function", () => {
    expect(typeof window.ThemeSwitcher.getCurrentTheme).toBe("function");
  });

  it("exports applyTheme function", () => {
    expect(typeof window.ThemeSwitcher.applyTheme).toBe("function");
  });

  it("exports THEMES object with correct keys", () => {
    const { THEMES } = window.ThemeSwitcher;
    expect(THEMES).toBeDefined();
    expect(THEMES.classic).toBe("theme-classic");
    expect(THEMES.green).toBe("theme-retro-green");
    expect(THEMES.sunset).toBe("theme-sunset");
  });
});

describe("theme-switcher.js — getCurrentTheme", () => {
  it("returns 'classic' by default when nothing is saved", () => {
    expect(window.ThemeSwitcher.getCurrentTheme()).toBe("classic");
  });

  it("returns saved theme from localStorage", () => {
    localStorage.setItem("color-theme", "sunset");
    expect(window.ThemeSwitcher.getCurrentTheme()).toBe("sunset");
  });

  it("returns 'green' when green is saved", () => {
    localStorage.setItem("color-theme", "green");
    expect(window.ThemeSwitcher.getCurrentTheme()).toBe("green");
  });
});

describe("theme-switcher.js — applyTheme", () => {
  it("adds theme-classic class to the root element for classic theme", () => {
    window.ThemeSwitcher.applyTheme("classic");
    expect(root.classList.contains("theme-classic")).toBe(true);
  });

  it("adds theme-retro-green class to the root element for green theme", () => {
    window.ThemeSwitcher.applyTheme("green");
    expect(root.classList.contains("theme-retro-green")).toBe(true);
  });

  it("adds theme-sunset class to the root element for sunset theme", () => {
    window.ThemeSwitcher.applyTheme("sunset");
    expect(root.classList.contains("theme-sunset")).toBe(true);
  });

  it("removes all other theme classes when switching", () => {
    root.classList.add("theme-classic");
    window.ThemeSwitcher.applyTheme("green");
    expect(root.classList.contains("theme-classic")).toBe(false);
    expect(root.classList.contains("theme-retro-green")).toBe(true);
  });

  it("saves the chosen theme to localStorage", () => {
    window.ThemeSwitcher.applyTheme("sunset");
    expect(localStorage.getItem("color-theme")).toBe("sunset");
  });

  it("overwrites previously saved theme in localStorage", () => {
    localStorage.setItem("color-theme", "classic");
    window.ThemeSwitcher.applyTheme("green");
    expect(localStorage.getItem("color-theme")).toBe("green");
  });

  it("does not add an unknown class for an unrecognised theme name", () => {
    window.ThemeSwitcher.applyTheme("nonexistent");
    expect(root.classList.contains("theme-nonexistent")).toBe(false);
  });

  it("removes previous theme classes even for an unrecognised name", () => {
    root.classList.add("theme-classic");
    window.ThemeSwitcher.applyTheme("nonexistent");
    expect(root.classList.contains("theme-classic")).toBe(false);
  });

  it("marks correct dropdown item as active", () => {
    document.body.innerHTML = `
      <span class="theme-option" data-theme="classic">Classic</span>
      <span class="theme-option" data-theme="green">Green</span>
      <span class="theme-option" data-theme="sunset">Sunset</span>
    `;
    window.ThemeSwitcher.applyTheme("green");
    const green = document.querySelector('[data-theme="green"]') as HTMLElement;
    const classic = document.querySelector(
      '[data-theme="classic"]',
    ) as HTMLElement;
    expect(green.classList.contains("active")).toBe(true);
    expect(classic.classList.contains("active")).toBe(false);
  });

  it("removes active class from previously active dropdown item", () => {
    document.body.innerHTML = `
      <span class="theme-option active" data-theme="classic">Classic</span>
      <span class="theme-option" data-theme="sunset">Sunset</span>
    `;
    window.ThemeSwitcher.applyTheme("sunset");
    const classic = document.querySelector(
      '[data-theme="classic"]',
    ) as HTMLElement;
    expect(classic.classList.contains("active")).toBe(false);
  });
});

/**
 * The flash this file exists to keep fixed.
 *
 * head.ejs loads theme-switcher.js synchronously in <head>, so when it runs
 * there is no <body> yet. The script used to write the theme class to
 * document.body and, finding it missing, deferred the whole thing to
 * DOMContentLoaded — by which point the document had been laid out and
 * painted in the default palette. Anyone on the green or sunset theme saw it
 * flash on every navigation.
 *
 * The rest of this suite cannot catch that: it evaluates the script in a
 * jsdom document that already has a <body>, which is exactly the branch that
 * always worked. This block reproduces the head-parse condition instead.
 */
describe("theme-switcher.js — applied before <body> exists", () => {
  it("puts the stored theme on the root element with no document to wait for", () => {
    localStorage.setItem("color-theme", "green");
    root.className = "";

    const listeners: string[] = [];
    const addEventListener = document.addEventListener.bind(document);

    Object.defineProperty(document, "body", {
      configurable: true,
      get: () => null,
    });
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      listeners.push(type);
      return (addEventListener as never as (...a: unknown[]) => void)(
        type,
        ...rest,
      );
    }) as typeof document.addEventListener;

    try {
      // eslint-disable-next-line no-eval
      (0, eval)(scriptContent);
    } finally {
      document.addEventListener = addEventListener;
      // Hands <body> back to the real prototype getter.
      delete (document as unknown as Record<string, unknown>).body;
    }

    // Applied by the time the script returns, not queued for later.
    expect(root.classList.contains("theme-retro-green")).toBe(true);
    expect(listeners).not.toContain("DOMContentLoaded");
  });
});

/**
 * The browser chrome, which the script keeps in step with the palette.
 *
 * views/head.ejs ships <meta name="theme-color"> as the classic blue on every
 * response and explains why it can do no better: the chosen theme is in
 * localStorage, so only the browser knows it. This is the half that does, and
 * it hangs off setThemeClass so a palette can never be applied without the
 * chrome following it.
 *
 * The value is read back out of the cascade rather than kept in a table in
 * the script — three hex codes copied there would be a second place to change
 * a colour, and the one nothing renders from.
 */
describe("theme-switcher.js — browser chrome colour", () => {
  function meta(): HTMLMetaElement | null {
    return document.querySelector('meta[name="theme-color"]');
  }

  beforeEach(() => {
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((el) => {
      el.remove();
    });
    root.removeAttribute("style");
  });

  function addMeta(content: string): HTMLMetaElement {
    const el = document.createElement("meta");
    el.setAttribute("name", "theme-color");
    el.setAttribute("content", content);
    document.head.appendChild(el);

    return el;
  }

  it("writes the palette's --nc-bg onto the tag", () => {
    addMeta("#0000aa");
    // Stands in for the html.theme-… block in style.css, which jsdom does not
    // load: what is being checked is that the script reads the property off
    // the cascade rather than from a table of its own.
    root.style.setProperty("--nc-bg", "#001400");

    window.ThemeSwitcher.applyTheme("green");

    expect(meta()!.getAttribute("content")).toBe("#001400");
  });

  it("follows a later switch rather than only the first", () => {
    addMeta("#0000aa");

    root.style.setProperty("--nc-bg", "#001400");
    window.ThemeSwitcher.applyTheme("green");

    root.style.setProperty("--nc-bg", "#1a0a2a");
    window.ThemeSwitcher.applyTheme("sunset");

    expect(meta()!.getAttribute("content")).toBe("#1a0a2a");
  });

  /**
   * Both lookups are allowed to fail without taking the theme switch down
   * with them: the stylesheet may not have loaded, and head.ejs is rendered
   * on its own by the view suite with no <meta> in sight.
   */
  it("keeps the markup's value when the property resolves to nothing", () => {
    addMeta("#0000aa");

    window.ThemeSwitcher.applyTheme("green");

    expect(meta()!.getAttribute("content")).toBe("#0000aa");
  });

  it("still applies the theme when there is no tag to update", () => {
    root.style.setProperty("--nc-bg", "#001400");

    expect(() => window.ThemeSwitcher.applyTheme("green")).not.toThrow();
    expect(root.classList.contains("theme-retro-green")).toBe(true);
  });
});

/**
 * The theme menu opened on :hover alone and its toggle was a <span>, so a
 * keyboard never reached it. The stylesheet now opens it on :focus-within;
 * this is the script's half — aria-expanded following focus, and Escape
 * closing it by dropping focus.
 */
describe("theme-switcher.js — dropdown state", () => {
  function mountDropdown() {
    document.body.innerHTML = `
      <div class="dropdown">
        <button class="dropdown-toggle" type="button" aria-haspopup="true" aria-expanded="false">Theme</button>
        <ul class="dropdown-menu">
          <li><a class="dropdown-item theme-option" href="#" data-theme="green">Green</a></li>
        </ul>
      </div>
      <button id="outside">elsewhere</button>
    `;
    (window.ThemeSwitcher as any).initDropdownState();

    return {
      dropdown: document.querySelector(".dropdown") as HTMLElement,
      toggle: document.querySelector(".dropdown-toggle") as HTMLButtonElement,
      item: document.querySelector(".theme-option") as HTMLAnchorElement,
      outside: document.getElementById("outside") as HTMLButtonElement,
    };
  }

  it("reports the menu open while the toggle has focus", () => {
    const { toggle } = mountDropdown();

    toggle.focus();

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps it open while focus moves to an item", () => {
    const { toggle, item } = mountDropdown();

    toggle.focus();
    item.focus();

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("reports it closed once focus leaves the menu", () => {
    const { toggle, outside } = mountDropdown();

    toggle.focus();
    outside.focus();

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape by dropping focus out of the menu", () => {
    const { dropdown, toggle, item } = mountDropdown();

    toggle.focus();
    item.focus();
    dropdown.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(dropdown.contains(document.activeElement)).toBe(false);
  });

  it("follows the pointer the way the stylesheet does", () => {
    const { dropdown, toggle } = mountDropdown();

    dropdown.dispatchEvent(new Event("mouseenter"));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    dropdown.dispatchEvent(new Event("mouseleave"));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not throw on a page with no dropdown", () => {
    document.body.innerHTML = "";

    expect(() => (window.ThemeSwitcher as any).initDropdownState()).not.toThrow();
  });
});
