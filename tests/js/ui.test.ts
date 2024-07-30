/**
 * @vitest-environment jsdom
 */
import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scriptContent = readFileSync(
  path.resolve(__dirname, "../../public/js/ui.js"),
  "utf-8",
);

beforeAll(() => {
  // Indirect eval exposes function declarations on globalThis
  // eslint-disable-next-line no-eval
  (0, eval)(scriptContent);
});

beforeEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

declare const window: Window &
  typeof globalThis & {
    initExpandedDescriptions: () => void;
    initAnchorScroll: () => void;
    initLoadingStates: () => void;
  };

describe("ui.js — initExpandedDescriptions", () => {
  it("expands the description when more-btn is clicked", () => {
    document.body.innerHTML = `
      <div class="description">
        <button class="more-btn">more...</button>
      </div>
    `;
    window.initExpandedDescriptions();

    const btn = document.querySelector(".more-btn") as HTMLButtonElement;
    btn.click();

    expect(
      document.querySelector(".description")!.classList.contains("expanded"),
    ).toBe(true);
    expect(btn.textContent).toBe("...less");
  });

  it("collapses the description when more-btn is clicked again", () => {
    document.body.innerHTML = `
      <div class="description expanded">
        <button class="more-btn">...less</button>
      </div>
    `;
    window.initExpandedDescriptions();

    const btn = document.querySelector(".more-btn") as HTMLButtonElement;
    btn.click();

    expect(
      document.querySelector(".description")!.classList.contains("expanded"),
    ).toBe(false);
    expect(btn.textContent).toBe("more...");
  });

  it("handles multiple independent description blocks", () => {
    document.body.innerHTML = `
      <div class="description"><button class="more-btn">more...</button></div>
      <div class="description"><button class="more-btn">more...</button></div>
    `;
    window.initExpandedDescriptions();

    const btns = document.querySelectorAll<HTMLButtonElement>(".more-btn");
    btns[0].click();

    const descs = document.querySelectorAll(".description");
    expect(descs[0].classList.contains("expanded")).toBe(true);
    expect(descs[1].classList.contains("expanded")).toBe(false);
  });

  it("does not throw when there are no description blocks", () => {
    expect(() => window.initExpandedDescriptions()).not.toThrow();
  });
});

describe("ui.js — initLoadingStates", () => {
  it("disables the submit button when the form is submitted", () => {
    document.body.innerHTML = `
      <form>
        <button type="submit">Submit</button>
      </form>
    `;
    window.initLoadingStates();

    const form = document.querySelector("form") as HTMLFormElement;
    const btn = document.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    form.dispatchEvent(new Event("submit"));

    expect(btn.disabled).toBe(true);
  });

  it("does not disable a button that is already disabled", () => {
    document.body.innerHTML = `
      <form>
        <button type="submit" disabled>Submit</button>
      </form>
    `;
    window.initLoadingStates();

    const form = document.querySelector("form") as HTMLFormElement;
    const btn = document.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    // btn.disabled is already true, the guard `!submitBtn.disabled` won't enter the block
    form.dispatchEvent(new Event("submit"));
    // It was disabled before and stays disabled
    expect(btn.disabled).toBe(true);
  });

  it("does not throw when form has no submit button", () => {
    document.body.innerHTML = `<form></form>`;
    window.initLoadingStates();

    const form = document.querySelector("form") as HTMLFormElement;
    expect(() => form.dispatchEvent(new Event("submit"))).not.toThrow();
  });

  it("does not throw when there are no forms", () => {
    expect(() => window.initLoadingStates()).not.toThrow();
  });
});

describe("ui.js — button hover is CSS-only", () => {
  it("leaves inline transform untouched on hover", () => {
    // Hover styling lives in the stylesheet; the old JS handler wrote an
    // inline transform that overrode it.
    document.body.innerHTML = `<a class="btn">Click</a>`;

    const btn = document.querySelector(".btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("mouseenter"));

    expect(btn.style.transform).toBe("");
  });
});

describe("ui.js — initAnchorScroll", () => {
  it("offsets the scroll target by the sticky navbar height", () => {
    document.body.innerHTML = `
      <div class="navbar"></div>
      <a href="#target">Go</a>
      <div id="target"></div>
    `;
    Object.defineProperty(
      document.querySelector(".navbar") as HTMLElement,
      "offsetHeight",
      { value: 80, configurable: true },
    );

    const scrollSpy = vi.fn();
    (window as any).scrollTo = scrollSpy;

    window.initAnchorScroll();
    (document.querySelector('a[href="#target"]') as HTMLElement).click();

    expect(scrollSpy).toHaveBeenCalledWith(
      expect.objectContaining({ top: expect.any(Number) }),
    );
    expect(scrollSpy.mock.calls[0][0].top).toBeLessThan(0);
  });

  it("ignores a bare '#' link", () => {
    document.body.innerHTML = `<a href="#">Nowhere</a>`;

    const scrollSpy = vi.fn();
    (window as any).scrollTo = scrollSpy;

    window.initAnchorScroll();
    (document.querySelector("a") as HTMLElement).click();

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("does not throw when there are no anchors", () => {
    expect(() => window.initAnchorScroll()).not.toThrow();
  });
});

describe("ui.js — DOMContentLoaded integration", () => {
  it("does not throw when DOMContentLoaded fires with full UI in DOM", () => {
    document.body.innerHTML = `
      <div class="description"><button class="more-btn">more...</button></div>
      <a class="btn">Btn</a>
      <form><button type="submit">Go</button></form>
    `;
    expect(() =>
      document.dispatchEvent(new Event("DOMContentLoaded")),
    ).not.toThrow();
  });
});

/**
 * The "more..." button said nothing to assistive tech about what it did or
 * whether the text was open, and was rendered even when the description
 * already fit in the collapsed box, where it expanded nothing.
 */
describe("ui.js — description toggle state", () => {
  function mountDescription(expanded = false) {
    document.body.innerHTML = `
      <div class="description${expanded ? " expanded" : ""}">
        <div class="description-content" id="game-description">Text</div>
        <button class="more-btn">${expanded ? "...less" : "more..."}</button>
      </div>
    `;

    return {
      content: document.getElementById("game-description") as HTMLElement,
      btn: document.querySelector(".more-btn") as HTMLButtonElement,
    };
  }

  function fakeLayout(el: HTMLElement, clientHeight: number, scrollHeight: number) {
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  }

  it("announces its state and what it controls", () => {
    const { btn } = mountDescription();

    (window as any).initExpandedDescriptions();

    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-controls")).toBe("game-description");
  });

  it("starts expanded when the markup does", () => {
    const { btn } = mountDescription(true);

    (window as any).initExpandedDescriptions();

    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("flips aria-expanded with each click", () => {
    const { btn } = mountDescription();
    (window as any).initExpandedDescriptions();

    btn.click();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.textContent).toBe("...less");

    btn.click();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.textContent).toBe("more...");
  });

  it("hides the button when the text already fits", () => {
    const { content, btn } = mountDescription();
    fakeLayout(content, 200, 180);

    (window as any).initExpandedDescriptions();

    expect(btn.hidden).toBe(true);
  });

  it("keeps the button when there is more to show", () => {
    const { content, btn } = mountDescription();
    fakeLayout(content, 200, 900);

    (window as any).initExpandedDescriptions();

    expect(btn.hidden).toBe(false);
  });

  it("keeps the button when no layout exists to measure", () => {
    const { content, btn } = mountDescription();
    fakeLayout(content, 0, 0);

    (window as any).initExpandedDescriptions();

    expect(btn.hidden).toBe(false);
  });
});
