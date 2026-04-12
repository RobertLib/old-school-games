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

beforeEach(() => {
  _lsStore.clear();
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
  it("adds theme-classic class to body for classic theme", () => {
    window.ThemeSwitcher.applyTheme("classic");
    expect(document.body.classList.contains("theme-classic")).toBe(true);
  });

  it("adds theme-retro-green class to body for green theme", () => {
    window.ThemeSwitcher.applyTheme("green");
    expect(document.body.classList.contains("theme-retro-green")).toBe(true);
  });

  it("adds theme-sunset class to body for sunset theme", () => {
    window.ThemeSwitcher.applyTheme("sunset");
    expect(document.body.classList.contains("theme-sunset")).toBe(true);
  });

  it("removes all other theme classes when switching", () => {
    document.body.classList.add("theme-classic");
    window.ThemeSwitcher.applyTheme("green");
    expect(document.body.classList.contains("theme-classic")).toBe(false);
    expect(document.body.classList.contains("theme-retro-green")).toBe(true);
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
    expect(document.body.classList.contains("theme-nonexistent")).toBe(false);
  });

  it("removes previous theme classes even for an unrecognised name", () => {
    document.body.classList.add("theme-classic");
    window.ThemeSwitcher.applyTheme("nonexistent");
    expect(document.body.classList.contains("theme-classic")).toBe(false);
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
