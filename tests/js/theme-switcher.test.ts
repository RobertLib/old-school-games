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
        <button class="dropdown-toggle" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="theme-menu">Theme</button>
        <ul class="dropdown-menu" id="theme-menu" role="menu">
          <li role="none"><button class="dropdown-item theme-option" type="button" role="menuitemradio" aria-checked="false" data-theme="classic">Classic</button></li>
          <li role="none"><button class="dropdown-item theme-option" type="button" role="menuitemradio" aria-checked="false" data-theme="green">Green</button></li>
          <li role="none"><button class="dropdown-item theme-option" type="button" role="menuitemradio" aria-checked="false" data-theme="sunset">Sunset</button></li>
        </ul>
      </div>
      <button id="outside">elsewhere</button>
    `;
    (window.ThemeSwitcher as any).initDropdownState();

    return {
      dropdown: document.querySelector(".dropdown") as HTMLElement,
      toggle: document.querySelector(".dropdown-toggle") as HTMLButtonElement,
      item: document.querySelector(".theme-option") as HTMLButtonElement,
      items: Array.from(
        document.querySelectorAll<HTMLButtonElement>(".theme-option"),
      ),
      outside: document.getElementById("outside") as HTMLButtonElement,
    };
  }

  function arrow(dropdown: HTMLElement, key: string) {
    // Cancelable, or preventDefault is a no-op and the assertions about it
    // would pass whatever the script did.
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });

    (document.activeElement ?? dropdown).dispatchEvent(event);

    return event;
  }

  /**
   * Focus on the toggle alone does not report an open menu, and the
   * stylesheet's :focus-within rule is scoped away from a dropdown this
   * script has claimed (.dropdown-js). Both halves of that are the same
   * point: closing on Escape hands focus back to the toggle, so a toggle
   * with focus has to be able to mean "closed".
   */
  it("claims the dropdown so the stylesheet's fallback stands down", () => {
    const { dropdown, toggle } = mountDropdown();

    expect(dropdown.classList.contains("dropdown-js")).toBe(true);

    toggle.focus();

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("reports it open once focus is inside the menu", () => {
    const { toggle, item } = mountDropdown();

    toggle.focus();
    item.focus();

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("reports it closed once focus leaves the menu", () => {
    const { dropdown, toggle, item, outside } = mountDropdown();

    toggle.click();
    item.focus();
    outside.focus();

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(dropdown.classList.contains("open")).toBe(false);
  });

  /**
   * Escape used to close the menu by blurring whatever had focus, which left
   * the visitor's place in the document nowhere — the next Tab started again
   * from the top of the page. The toggle is where they were before they
   * opened it, so that is where focus goes back to.
   */
  it("closes on Escape and hands focus back to the toggle", () => {
    const { dropdown, toggle, item } = mountDropdown();

    toggle.click();
    item.focus();
    arrow(dropdown, "Escape");

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(dropdown.classList.contains("open")).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  /**
   * Enter or Space on the toggle is how a keyboard shuts the menu it opened,
   * and that click used to blur whatever in the dropdown had focus — the
   * toggle itself — so focus fell to <body> and the next Tab started again
   * from the top of the page.
   */
  it("keeps focus on the toggle when the toggle closes the menu", () => {
    const { dropdown, toggle } = mountDropdown();

    toggle.focus();
    toggle.click();
    toggle.click();

    expect(dropdown.classList.contains("open")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  // The item focus is on is about to be hidden, so it cannot stay there —
  // the toggle that was just pressed is where it goes, as it does on Escape.
  it("hands focus from an item back to the toggle when the toggle closes the menu", () => {
    const { dropdown, toggle, items } = mountDropdown();

    toggle.click();
    items[1].focus();
    toggle.click();

    expect(dropdown.classList.contains("open")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("leaves focus that was never in the dropdown where it is", () => {
    const { toggle, outside } = mountDropdown();

    toggle.click();
    outside.focus();
    toggle.click();

    expect(document.activeElement).toBe(outside);
  });

  it("follows the pointer the way the stylesheet does", () => {
    const { dropdown, toggle } = mountDropdown();

    dropdown.dispatchEvent(new Event("mouseenter"));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    dropdown.dispatchEvent(new Event("mouseleave"));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  /**
   * The menu opened on :hover and :focus-within alone, which is nothing at
   * all on a touch screen: a tap fires no hover, and tapping the toggle — a
   * <button> that had no click handler — did nothing whatsoever. The class
   * the handler adds is what .dropdown.open .dropdown-menu in
   * public/css/style.css opens on.
   */
  it("opens on a click of the toggle and closes on the next one", () => {
    const { dropdown, toggle } = mountDropdown();

    toggle.click();

    expect(dropdown.classList.contains("open")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    toggle.click();

    expect(dropdown.classList.contains("open")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when a click lands outside it", () => {
    const { dropdown, toggle, outside } = mountDropdown();

    toggle.click();
    outside.click();

    expect(dropdown.classList.contains("open")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("stays open for a click on one of its own items", () => {
    const { dropdown, toggle, item } = mountDropdown();

    toggle.click();
    item.click();

    expect(dropdown.classList.contains("open")).toBe(true);
  });

  /**
   * role="menu" promises an arrow-key model and there was none — the three
   * options were reachable only by Tab, which is the behaviour the role tells
   * a screen reader not to expect.
   */
  it("opens on ArrowDown from the toggle and focuses the first item", () => {
    const { dropdown, toggle, items } = mountDropdown();

    toggle.focus();
    const event = arrow(dropdown, "ArrowDown");

    expect(dropdown.classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    // Or the page scrolls at the same time as the focus moves.
    expect(event.defaultPrevented).toBe(true);
  });

  it("walks down the items and wraps round to the first", () => {
    const { dropdown, toggle, items } = mountDropdown();

    toggle.focus();
    arrow(dropdown, "ArrowDown");
    arrow(dropdown, "ArrowDown");

    expect(document.activeElement).toBe(items[1]);

    arrow(dropdown, "ArrowDown");
    arrow(dropdown, "ArrowDown");

    expect(document.activeElement).toBe(items[0]);
  });

  it("opens on ArrowUp from the toggle at the last item", () => {
    const { dropdown, toggle, items } = mountDropdown();

    toggle.focus();
    arrow(dropdown, "ArrowUp");

    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("jumps to the ends with Home and End", () => {
    const { dropdown, toggle, items } = mountDropdown();

    toggle.click();
    items[1].focus();

    arrow(dropdown, "End");
    expect(document.activeElement).toBe(items[items.length - 1]);

    arrow(dropdown, "Home");
    expect(document.activeElement).toBe(items[0]);
  });

  // Home and End belong to the document while focus is on the toggle: the
  // menu is not where the visitor is yet.
  it("leaves Home and End alone outside the menu", () => {
    const { dropdown, toggle } = mountDropdown();

    toggle.focus();
    const event = arrow(dropdown, "Home");

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  /**
   * Roving tabindex, so the group is one tab stop rather than three, and the
   * stop is on the choice that is in force. The markup carries no tabindex
   * of its own — with this script blocked the buttons stay natively focusable
   * and the :focus-within rule still opens the menu for them.
   */
  it("puts the one tab stop on the chosen theme", () => {
    const { items } = mountDropdown();

    window.ThemeSwitcher.applyTheme("sunset");

    expect(items.map((item) => item.getAttribute("tabindex"))).toEqual([
      "-1",
      "-1",
      "0",
    ]);
  });

  it("does not throw on a page with no dropdown", () => {
    document.body.innerHTML = "";

    expect(() => (window.ThemeSwitcher as any).initDropdownState()).not.toThrow();
  });
});

/**
 * A stored theme name the script does not know — one since retired, or a
 * value something else on the origin wrote under the key.
 *
 * It used to be passed on as it was. No option matched it, so every one got
 * tabindex="-1" and aria-checked="false": a radio group with nothing checked
 * and a menu with no tab stop at all, over a page drawn in the classic
 * palette regardless. Read as the default instead, it is the default in every
 * respect.
 */
describe("theme-switcher.js — a stored theme it does not know", () => {
  /** A page load: the stored value, the navbar's menu, then the script. */
  function loadWithStored(value: string) {
    localStorage.setItem("color-theme", value);
    document.body.innerHTML = `
      <div class="dropdown">
        <button class="dropdown-toggle" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="theme-menu">Theme</button>
        <ul class="dropdown-menu" id="theme-menu" role="menu">
          <li role="none"><button class="dropdown-item theme-option" type="button" role="menuitemradio" aria-checked="false" data-theme="classic">Classic</button></li>
          <li role="none"><button class="dropdown-item theme-option" type="button" role="menuitemradio" aria-checked="false" data-theme="green">Green</button></li>
          <li role="none"><button class="dropdown-item theme-option" type="button" role="menuitemradio" aria-checked="false" data-theme="sunset">Sunset</button></li>
        </ul>
      </div>
    `;

    // eslint-disable-next-line no-eval
    (0, eval)(scriptContent);

    return Array.from(
      document.querySelectorAll<HTMLButtonElement>(".theme-option"),
    );
  }

  it("reads it as the default", () => {
    localStorage.setItem("color-theme", "amber");

    expect(window.ThemeSwitcher.getCurrentTheme()).toBe("classic");
  });

  it("leaves the menu its one tab stop, on the default, checked", () => {
    const items = loadWithStored("amber");

    expect(items.map((item) => item.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
    ]);
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(root.classList.contains("theme-classic")).toBe(true);
  });

  // `in`, or a bare THEMES[name], finds Object.prototype.toString — and
  // classList.add throws on the function's source, which has spaces in it,
  // taking the whole switcher down on load.
  it("does not take a name off Object.prototype for a theme", () => {
    expect(() => loadWithStored("toString")).not.toThrow();
    expect(window.ThemeSwitcher.getCurrentTheme()).toBe("classic");
    expect(root.classList.contains("theme-classic")).toBe(true);
  });

  it("still reads a theme it does know", () => {
    const items = loadWithStored("sunset");

    expect(window.ThemeSwitcher.getCurrentTheme()).toBe("sunset");
    expect(items[2].getAttribute("tabindex")).toBe("0");
  });
});

/**
 * The three options are a radio group: mutually exclusive, exactly one in
 * force. views/navbar.ejs gives them role="menuitemradio", and the state
 * that role promises is aria-checked — the .active class it used to be told
 * apart by is a colour, and a colour is not something a screen reader reads.
 */
describe("theme-switcher.js — the chosen theme is announced", () => {
  function mountOptions() {
    document.body.innerHTML = `
      <ul role="menu">
        <li role="none"><button class="theme-option" type="button" role="menuitemradio" aria-checked="false" data-theme="classic">Classic</button></li>
        <li role="none"><button class="theme-option" type="button" role="menuitemradio" aria-checked="false" data-theme="green">Green</button></li>
        <li role="none"><button class="theme-option" type="button" role="menuitemradio" aria-checked="false" data-theme="sunset">Sunset</button></li>
      </ul>
    `;

    return (theme: string) =>
      document.querySelector(`[data-theme="${theme}"]`) as HTMLElement;
  }

  function checkedThemes() {
    return Array.from(
      document.querySelectorAll<HTMLElement>(".theme-option"),
    )
      .filter((item) => item.getAttribute("aria-checked") === "true")
      .map((item) => item.dataset.theme);
  }

  it("checks exactly the theme that was applied", () => {
    const option = mountOptions();

    (window as any).ThemeSwitcher.applyTheme("green");

    expect(checkedThemes()).toEqual(["green"]);
    expect(option("classic").getAttribute("aria-checked")).toBe("false");
  });

  // aria-checked="false" and not a removed attribute: unlike aria-current,
  // a radio that is not checked is a state the role requires to be stated.
  it("moves the check rather than adding a second one", () => {
    mountOptions();

    (window as any).ThemeSwitcher.applyTheme("green");
    (window as any).ThemeSwitcher.applyTheme("sunset");

    expect(checkedThemes()).toEqual(["sunset"]);
  });

  it("keeps aria-checked in step with the .active class", () => {
    const option = mountOptions();

    (window as any).ThemeSwitcher.applyTheme("sunset");

    document.querySelectorAll<HTMLElement>(".theme-option").forEach((item) => {
      expect(item.getAttribute("aria-checked")).toBe(
        String(item.classList.contains("active")),
      );
    });
    expect(option("sunset").classList.contains("active")).toBe(true);
  });
});
