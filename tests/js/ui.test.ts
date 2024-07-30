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
    initLocalDates: (root?: ParentNode) => void;
  };

/**
 * A submit that reaches the document, which is where both submit handlers in
 * ui.js now live.
 *
 * `bubbles: true` matters: a bare new Event("submit") does not bubble, so it
 * never leaves the form — which is how these tests used to pass against a
 * listener attached to the form itself and would have gone on passing against
 * a delegated one that was never registered at all.
 */
function submitForm(form: HTMLFormElement): Event {
  const event = new Event("submit", { bubbles: true, cancelable: true });

  form.dispatchEvent(event);

  return event;
}

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

/**
 * The delegated submit-button lock.
 *
 * Delegated to the document, like the data-confirm handler above and for the
 * same reason: it used to bind one listener per form on DOMContentLoaded, so
 * the admin delete forms inside comments fetched afterwards were never
 * covered. The last case here is the one that checks that.
 */
describe("ui.js — loading states", () => {
  it("disables the submit button when the form is submitted", () => {
    document.body.innerHTML = `
      <form>
        <button type="submit">Submit</button>
      </form>
    `;

    const form = document.querySelector("form") as HTMLFormElement;
    const btn = document.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    submitForm(form);

    expect(btn.disabled).toBe(true);
  });

  it("does not disable a button that is already disabled", () => {
    document.body.innerHTML = `
      <form>
        <button type="submit" disabled>Submit</button>
      </form>
    `;

    const form = document.querySelector("form") as HTMLFormElement;
    const btn = document.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    // btn.disabled is already true, the guard `!submitBtn.disabled` won't enter the block
    submitForm(form);
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

    const form = document.querySelector("form") as HTMLFormElement;
    const btn = document.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    submitForm(form);

    expect(btn.disabled).toBe(false);
  });

  it("does not throw when form has no submit button", () => {
    document.body.innerHTML = `<form></form>`;

    const form = document.querySelector("form") as HTMLFormElement;
    expect(() => submitForm(form)).not.toThrow();
  });

  // The point of delegating: the comment list is built by fetch after load,
  // and its admin delete forms are exactly the ones a double submit would
  // send a second DELETE for.
  it("covers a form added to the page afterwards", () => {
    document.body.innerHTML = "";

    const form = document.createElement("form");

    form.innerHTML = '<button type="submit">Delete</button>';
    document.body.appendChild(form);

    submitForm(form);

    expect(
      (form.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
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

  // Both handlers are on the document now, this one in the capture phase and
  // the loading-state one in the bubble phase — so stopping propagation here
  // is still what keeps the button the visitor just kept from being disabled
  // for five seconds.
  it("stops the event before the loading-state listener sees it", () => {
    vi.spyOn(window, "confirm").mockImplementation(() => false);

    const form = mountForm();

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

  /**
   * public/js/comments.js calls this with the comment list after it has
   * prepended a fetched batch. Without the argument it could only ever be run
   * over the whole document once, on DOMContentLoaded — so a thread that had
   * been extended showed the server's "January 5, 2026" above the rewritten
   * "Jan 5, 2026" in one list.
   */
  it("rewrites only inside the subtree it is handed", () => {
    document.body.innerHTML = `
      <span id="outside" data-date="2001-02-03T00:00:00.000Z">untouched</span>
      <div id="batch">
        <span data-date="1994-12-10T00:00:00.000Z">raw</span>
      </div>
    `;

    (window as any).initLocalDates(document.getElementById("batch"));

    expect(document.getElementById("outside")!.textContent).toBe("untouched");
    expect(
      document.querySelector("#batch [data-date]")!.textContent,
    ).not.toBe("raw");
  });

  // It is reachable from another script, which is the whole point: the
  // codebase has no module system on the client.
  it("is exposed on window", () => {
    expect(typeof (window as any).initLocalDates).toBe("function");
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

  it("leaves the text alone entirely under reduced motion", () => {
    mockMotion(true);

    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    const ticker = mountTicker();

    (window as any).initTicker();

    // No transform written, and no frame loop started: the stylesheet lays
    // the text out statically for this preference and the two would fight.
    expect(ticker.style.transform).toBe("");
    expect(rafSpy).not.toHaveBeenCalled();
  });

  /**
   * The text is visible from the first paint — the stylesheet no longer
   * hides it, so a visitor with this script blocked reads the line instead of
   * a blank bar. What the script still has to do is write the starting
   * position before the loop runs, or the first frame shows the text at 0 and
   * it jumps to the right.
   */
  it("positions the text off to the right before the first frame", () => {
    mockMotion(false);

    const ticker = mountTicker();

    Object.defineProperty(
      document.querySelector(".ticker-wrap") as HTMLElement,
      "offsetWidth",
      { configurable: true, value: 400 },
    );

    (window as any).initTicker();

    expect(ticker.style.transform).toBe("translateX(400px)");
    // Nothing is hidden and then revealed any more, in either branch.
    expect(ticker.style.visibility).toBe("");
  });

  it("does not throw when the page has no ticker", () => {
    mockMotion(false);

    expect(() => (window as any).initTicker()).not.toThrow();
  });
});

/**
 * The pause control WCAG 2.2.2 asks for.
 *
 * The line scrolls for as long as the page is open, and the only thing that
 * stopped it was prefers-reduced-motion — a system setting, not a control on
 * the page. The button is modelled on the carousel's: named for what
 * pressing it will do, the icon saying the same, and no aria-pressed.
 */
describe("ui.js — pausing the ticker", () => {
  const indexView = readFileSync(
    path.resolve(__dirname, "../../views/index.ejs"),
    "utf-8",
  );
  const stylesheet = readFileSync(
    path.resolve(__dirname, "../../public/css/style.css"),
    "utf-8",
  );

  /**
   * The ticker exactly as views/index.ejs writes it — the template with its
   * EJS tags taken out, parsed, and the .ticker-wrap lifted from it — so a
   * class renamed on one side and not the other fails here rather than on
   * the homepage.
   */
  function realTicker() {
    const html = indexView.replace(/<%[\s\S]*?%>/g, "");
    const wrap = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector(".ticker-wrap");

    expect(wrap, "no .ticker-wrap in views/index.ejs").not.toBeNull();

    return wrap!.outerHTML;
  }

  /** requestAnimationFrame under the test's control: frames run when told. */
  function fakeFrames() {
    const queue = new Map<number, FrameRequestCallback>();
    let nextId = 0;

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextId += 1;
      queue.set(nextId, callback);

      return nextId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      queue.delete(id);
    });

    return {
      run(timestamp: number) {
        const due = [...queue.values()];

        queue.clear();
        due.forEach((callback) => callback(timestamp));
      },
      get pending() {
        return queue.size;
      },
    };
  }

  function mount({ reduceMotion = false } = {}) {
    (window as any).matchMedia = vi
      .fn()
      .mockReturnValue({ matches: reduceMotion });
    document.body.innerHTML = realTicker();

    // jsdom has no layout: the box the text scrolls across is given a width.
    Object.defineProperty(
      document.querySelector(".ticker-viewport") as HTMLElement,
      "offsetWidth",
      { configurable: true, value: 300 },
    );

    const frames = fakeFrames();

    (window as any).initTicker();

    return {
      frames,
      wrap: document.querySelector(".ticker-wrap") as HTMLElement,
      ticker: document.querySelector(".ticker") as HTMLElement,
      toggle: document.querySelector(".ticker-toggle") as HTMLButtonElement,
      icon: document.querySelector(".ticker-toggle-icon") as HTMLElement,
    };
  }

  /** Two frames a second apart: 80px of travel at the ticker's speed. */
  function play(frames: ReturnType<typeof fakeFrames>, from: number) {
    frames.run(from);
    frames.run(from + 1000);
  }

  it("ships the button hidden, as a real button, with no inline handler", () => {
    const markup = realTicker();
    const button = /<button[^>]*class="ticker-toggle"[^>]*>/.exec(markup);

    expect(button, "no .ticker-toggle in the ticker").not.toBeNull();
    expect(button![0]).toMatch(/\stype="button"/);
    expect(button![0]).toMatch(/\shidden\b/);
    expect(button![0]).toContain('aria-label="Pause scrolling text"');
    expect(button![0]).not.toContain("aria-pressed");
    // script-src-attr is 'none': an onclick would simply never run.
    expect(markup).not.toMatch(/\son[a-z]+=/i);
  });

  it("reveals the button once the text is moving", () => {
    const { toggle } = mount();

    expect(toggle.hidden).toBe(false);
    expect(toggle.getAttribute("aria-label")).toBe("Pause scrolling text");
  });

  it("stops the text where it is when pressed", () => {
    const { frames, ticker, toggle, icon } = mount();

    play(frames, 0);
    expect(ticker.style.transform).toBe("translateX(220px)");

    toggle.click();

    // No frame left queued, so nothing moves it again.
    expect(frames.pending).toBe(0);
    frames.run(5000);
    expect(ticker.style.transform).toBe("translateX(220px)");

    expect(toggle.getAttribute("aria-label")).toBe("Resume scrolling text");
    expect(toggle.hasAttribute("aria-pressed")).toBe(false);
    expect(icon.textContent).toBe("▶");
  });

  // From where it stopped, not from wherever the clock says it would have
  // been had it never paused.
  it("carries on from where it stopped when pressed again", () => {
    const { frames, ticker, toggle, icon } = mount();

    play(frames, 0);
    toggle.click();
    toggle.click();
    play(frames, 60_000);

    expect(ticker.style.transform).toBe("translateX(140px)");
    expect(toggle.getAttribute("aria-label")).toBe("Pause scrolling text");
    expect(icon.textContent).toBe("❚❚");
  });

  it("is not restarted by the tab coming back while it is paused", () => {
    const { frames, wrap, toggle } = mount();

    // On screen, which is what the visibilitychange handler asks.
    wrap.getBoundingClientRect = () => ({ bottom: 100 }) as DOMRect;

    toggle.click();
    document.dispatchEvent(new Event("visibilitychange"));

    expect(frames.pending).toBe(0);
  });

  // Nothing moves under this preference, so there is nothing to pause.
  it("keeps the button hidden under reduced motion", () => {
    const { toggle } = mount({ reduceMotion: true });

    expect(toggle.hidden).toBe(true);
  });

  // The text is clipped to the box beside the button, so that box — not the
  // whole row — is the edge it enters from.
  it("starts the text at the edge of its own box, not of the row", () => {
    const { ticker } = mount();

    expect(ticker.style.transform).toBe("translateX(300px)");
  });

  it("draws a focus ring on the button and hides it when motion is reduced", () => {
    expect(stylesheet).toMatch(
      /\.ticker-toggle:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--nc-title\)/,
    );

    const reduced = [
      ...stylesheet.matchAll(
        /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g,
      ),
    ]
      .map((match) => match[1])
      .join("\n");

    expect(reduced).toMatch(/\.ticker-toggle\s*\{\s*display:\s*none/);
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
