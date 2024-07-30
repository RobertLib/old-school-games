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

  // The comment form posts itself over fetch and manages its own button; a
  // fixed five-second re-enable here let a slow request be sent twice.
  it("leaves a form marked data-async alone", () => {
    document.body.innerHTML = `
      <form data-async>
        <button type="submit">Post</button>
      </form>
    `;
    window.initLoadingStates();

    const form = document.querySelector("form") as HTMLFormElement;
    const btn = document.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    form.dispatchEvent(new Event("submit"));

    expect(btn.disabled).toBe(false);
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

/**
 * The delegated "are you sure?" handler.
 *
 * It replaced onsubmit="return confirm(…)" attributes, which is what let
 * script-src-attr go to 'none' — so if this ever stops cancelling, the only
 * thing standing between a mis-click and a deleted game is gone, and nothing
 * in the markup would show it. Registered on the document at load rather
 * than inside DOMContentLoaded, so a form inserted by fetch is covered too:
 * the last case here is the one that checks that.
 */
describe("ui.js — data-confirm", () => {
  function mountForm(attrs = 'data-confirm="Sure?"') {
    document.body.innerHTML = `<form ${attrs}><button type="submit">Go</button></form>`;

    return document.querySelector("form") as HTMLFormElement;
  }

  function submit(form: HTMLFormElement) {
    const event = new Event("submit", { bubbles: true, cancelable: true });

    form.dispatchEvent(event);

    return event;
  }

  it("cancels the submit when the visitor says no", () => {
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => false);
    const event = submit(mountForm());

    expect(confirmSpy).toHaveBeenCalledWith("Sure?");
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets the submit through when the visitor says yes", () => {
    vi.spyOn(window, "confirm").mockImplementation(() => true);

    expect(submit(mountForm()).defaultPrevented).toBe(false);
  });

  it("never asks on a form without the attribute", () => {
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => false);

    expect(submit(mountForm("")).defaultPrevented).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  // The whole point of delegating to the document: the comment list and the
  // collection lists are built after load.
  it("covers a form added to the page afterwards", () => {
    vi.spyOn(window, "confirm").mockImplementation(() => false);

    document.body.innerHTML = "";

    const form = document.createElement("form");

    form.dataset.confirm = "Sure?";
    document.body.appendChild(form);

    expect(submit(form).defaultPrevented).toBe(true);
  });

  // initLoadingStates sits on the form itself, so a cancelled submit must not
  // reach it — otherwise the button the visitor just kept is disabled for
  // five seconds.
  it("stops the event before the loading-state listener sees it", () => {
    vi.spyOn(window, "confirm").mockImplementation(() => false);

    const form = mountForm();

    window.initLoadingStates();
    submit(form);

    expect(
      (form.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

/**
 * --navbar-height is what the sticky sidebars and scroll-padding-top are
 * measured against; the stylesheet only carries a desktop guess.
 */
describe("ui.js — syncNavbarHeight", () => {
  function mountNavbar(height: number) {
    document.body.innerHTML = `<div class="navbar"></div>`;

    Object.defineProperty(
      document.querySelector(".navbar") as HTMLElement,
      "offsetHeight",
      { configurable: true, value: height },
    );
  }

  it("writes the measured height to the root element", () => {
    mountNavbar(96);

    (window as any).syncNavbarHeight();

    expect(
      document.documentElement.style.getPropertyValue("--navbar-height"),
    ).toBe("96px");
  });

  // A height of zero is a navbar that has not been laid out yet, not a
  // navbar that is no pixels tall; writing it would collapse the offsets.
  it("leaves the property alone when nothing has been laid out", () => {
    document.documentElement.style.removeProperty("--navbar-height");
    mountNavbar(0);

    (window as any).syncNavbarHeight();

    expect(
      document.documentElement.style.getPropertyValue("--navbar-height"),
    ).toBe("");
  });

  it("does not throw when the page has no navbar", () => {
    expect(() => (window as any).syncNavbarHeight()).not.toThrow();
  });
});

describe("ui.js — initLocalDates", () => {
  it("rewrites every data-date in the visitor's own locale", () => {
    document.body.innerHTML = `
      <span data-date="2001-02-03T00:00:00.000Z">2001-02-03</span>
      <span data-date="1994-12-10T00:00:00.000Z">1994-12-10</span>
    `;

    (window as any).initLocalDates();

    const [first, second] = Array.from(
      document.querySelectorAll<HTMLElement>("[data-date]"),
    );

    expect(first.textContent).toBe(
      new Date("2001-02-03T00:00:00.000Z").toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    );
    expect(second.textContent).not.toBe("1994-12-10");
  });

  it("does not throw when there are no dates", () => {
    expect(() => (window as any).initLocalDates()).not.toThrow();
  });
});

/**
 * The marquee. What matters here is that it respects the reduced-motion
 * preference — a scrolling line of text is exactly the thing that setting is
 * for — and that it does not start a frame loop on a page without one.
 */
describe("ui.js — initTicker", () => {
  function mockMotion(reduce: boolean) {
    (window as any).matchMedia = vi.fn().mockReturnValue({ matches: reduce });
  }

  function mountTicker() {
    document.body.innerHTML = `
      <div class="ticker-wrap"><div class="ticker">News</div></div>
    `;

    return document.querySelector(".ticker") as HTMLElement;
  }

  it("shows the text without animating it under reduced motion", () => {
    mockMotion(true);

    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    const ticker = mountTicker();

    (window as any).initTicker();

    expect(ticker.style.visibility).toBe("visible");
    // No transform written, and no frame loop started: the stylesheet lays
    // the text out statically for this preference and the two would fight.
    expect(ticker.style.transform).toBe("");
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it("positions the text off to the right before revealing it", () => {
    mockMotion(false);

    const ticker = mountTicker();

    Object.defineProperty(
      document.querySelector(".ticker-wrap") as HTMLElement,
      "offsetWidth",
      { configurable: true, value: 400 },
    );

    (window as any).initTicker();

    expect(ticker.style.transform).toBe("translateX(400px)");
    expect(ticker.style.visibility).toBe("visible");
  });

  it("does not throw when the page has no ticker", () => {
    mockMotion(false);

    expect(() => (window as any).initTicker()).not.toThrow();
  });
});

/**
 * Landing on /some-game#comment-42: the browser scrolls before this script
 * runs, so the jump is redone once the layout has settled.
 */
describe("ui.js — initHashLanding", () => {
  function setHash(hash: string) {
    window.location.hash = hash;
  }

  it("re-lands on the target once a frame has passed", () => {
    document.body.innerHTML = `<div id="comment-42"></div>`;
    setHash("#comment-42");

    const target = document.getElementById("comment-42") as HTMLElement;
    const scrollIntoView = vi.fn();

    target.scrollIntoView = scrollIntoView;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      (cb as FrameRequestCallback)(0);
      return 1;
    });

    (window as any).initHashLanding();

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "auto",
    });
  });

  // "#1" is a legal fragment and an illegal selector. querySelector throws on
  // it, and an exception here used to take the rest of the handler with it.
  it("survives a hash that is not a valid selector", () => {
    setHash("#1");

    expect(() => (window as any).initHashLanding()).not.toThrow();
  });

  it("does nothing when the hash names nothing on the page", () => {
    document.body.innerHTML = "";
    setHash("#nowhere");

    expect(() => (window as any).initHashLanding()).not.toThrow();
  });

  it("does nothing when there is no hash at all", () => {
    setHash("");

    const rafSpy = vi.spyOn(window, "requestAnimationFrame");

    (window as any).initHashLanding();

    expect(rafSpy).not.toHaveBeenCalled();
  });
});

/**
 * The skip link is the reason initAnchorScroll has to do more than scroll.
 *
 * preventDefault cancels the whole navigation, and with it the two things the
 * browser would have done for free: move focus to the target and put the
 * fragment in the address bar. Without the first, "Skip to content" scrolled
 * the page and left focus on the link, so the next Tab went straight back
 * into the navbar the visitor had just asked to skip.
 */
describe("ui.js — initAnchorScroll and the skip link", () => {
  beforeEach(() => {
    (window as any).scrollTo = vi.fn();
  });

  function mountSkipLink() {
    document.body.innerHTML = `
      <a class="skip-link" href="#main">Skip to content</a>
      <div class="navbar"><a href="/">Home</a></div>
      <main id="main" tabindex="-1">Content</main>
    `;

    (window as any).initAnchorScroll();

    return document.querySelector(".skip-link") as HTMLAnchorElement;
  }

  it("moves focus to the target it scrolled to", () => {
    mountSkipLink().click();

    expect(document.activeElement).toBe(document.getElementById("main"));
  });

  it("puts the fragment in the address bar", () => {
    const pushState = vi.spyOn(window.history, "pushState");

    mountSkipLink().click();

    expect(pushState).toHaveBeenCalledWith(null, "", "#main");
  });

  // Same reason as initHashLanding above: href="#1" is legal markup.
  it("leaves a hash that is not a selector to the browser", () => {
    document.body.innerHTML = `<a href="#1">Odd</a>`;
    (window as any).initAnchorScroll();

    const link = document.querySelector("a") as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });

    expect(() => link.dispatchEvent(event)).not.toThrow();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not throw for a target that cannot take focus", () => {
    document.body.innerHTML = `
      <a href="#plain">Go</a>
      <div id="plain"></div>
    `;
    (window as any).initAnchorScroll();

    expect(() =>
      (document.querySelector('a[href="#plain"]') as HTMLElement).click(),
    ).not.toThrow();
  });
});
