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
    initHoverEffects: () => void;
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

describe("ui.js — initHoverEffects", () => {
  it("applies translateY(-1px) on mouseenter", () => {
    document.body.innerHTML = `<a class="btn">Click</a>`;
    window.initHoverEffects();

    const btn = document.querySelector(".btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("mouseenter"));
    expect(btn.style.transform).toBe("translateY(-1px)");
  });

  it("resets transform to translateY(0) on mouseleave", () => {
    document.body.innerHTML = `<a class="btn">Click</a>`;
    window.initHoverEffects();

    const btn = document.querySelector(".btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("mouseenter"));
    btn.dispatchEvent(new MouseEvent("mouseleave"));
    expect(btn.style.transform).toBe("translateY(0)");
  });

  it("does not throw when there are no .btn elements", () => {
    expect(() => window.initHoverEffects()).not.toThrow();
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
