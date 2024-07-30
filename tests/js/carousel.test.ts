/**
 * @vitest-environment jsdom
 */
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scriptContent = readFileSync(
  path.resolve(__dirname, "../../public/js/carousel.js"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// jsdom has no layout engine — mock offsetWidth so carousel math works
// ---------------------------------------------------------------------------
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    return 200;
  },
});

function buildCarouselHTML(slideCount = 6): string {
  const slides = Array.from(
    { length: slideCount },
    (_, i) =>
      `<div class="carousel-slide" style="width:200px">Slide ${i + 1}</div>`,
  ).join("");
  const indicators = Array.from(
    { length: slideCount },
    (_, i) =>
      `<span class="carousel-indicator${i === 0 ? " active" : ""}"></span>`,
  ).join("");
  return `
    <section class="featured-games-carousel" tabindex="0">
      <div class="carousel-track" style="gap:0px">${slides}</div>
      <button class="carousel-btn-prev">Prev</button>
      <button class="carousel-btn-next">Next</button>
      <div class="indicators">${indicators}</div>
    </section>
  `;
}

beforeAll(() => {
  // Indirect eval registers the DOMContentLoaded listener on document
  // eslint-disable-next-line no-eval
  (0, eval)(scriptContent);
});

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = buildCarouselHTML();
  // Trigger the registered DOMContentLoaded callback to initialize the carousel
  document.dispatchEvent(new Event("DOMContentLoaded"));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("carousel.js — initialization", () => {
  it("does not throw when no carousel element is present", () => {
    document.body.innerHTML = "";
    expect(() =>
      document.dispatchEvent(new Event("DOMContentLoaded")),
    ).not.toThrow();
  });

  it("does not throw when carousel has no track", () => {
    document.body.innerHTML = `<section class="featured-games-carousel"></section>`;
    expect(() =>
      document.dispatchEvent(new Event("DOMContentLoaded")),
    ).not.toThrow();
  });

  it("renders buttons as always-enabled (infinite loop mode)", () => {
    const prev = document.querySelector(
      ".carousel-btn-prev",
    ) as HTMLButtonElement;
    const next = document.querySelector(
      ".carousel-btn-next",
    ) as HTMLButtonElement;
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(false);
  });
});

describe("carousel.js — next / prev navigation", () => {
  it("next button changes track transform", () => {
    const track = document.querySelector(".carousel-track") as HTMLElement;
    const nextBtn = document.querySelector(
      ".carousel-btn-next",
    ) as HTMLButtonElement;
    const initial = track.style.transform;

    nextBtn.click();

    expect(track.style.transform).not.toBe(initial);
  });

  it("prev button on first slide wraps around to the last valid position", () => {
    const track = document.querySelector(".carousel-track") as HTMLElement;
    const prevBtn = document.querySelector(
      ".carousel-btn-prev",
    ) as HTMLButtonElement;

    prevBtn.click();

    // Wrapped past beginning → transform is NOT translateX(0px)
    expect(track.style.transform).not.toBe("translateX(0px)");
  });

  it("next then prev returns to the initial position", () => {
    const track = document.querySelector(".carousel-track") as HTMLElement;
    const nextBtn = document.querySelector(
      ".carousel-btn-next",
    ) as HTMLButtonElement;
    const prevBtn = document.querySelector(
      ".carousel-btn-prev",
    ) as HTMLButtonElement;
    const initial = track.style.transform;

    nextBtn.click();
    prevBtn.click();

    expect(track.style.transform).toBe(initial);
  });

  it("clicking next multiple times eventually loops back to start", () => {
    const track = document.querySelector(".carousel-track") as HTMLElement;
    const nextBtn = document.querySelector(
      ".carousel-btn-next",
    ) as HTMLButtonElement;
    const initial = track.style.transform;

    // Click until the carousel wraps back to position 0 (max 20 attempts)
    let looped = false;
    for (let i = 0; i < 20; i++) {
      nextBtn.click();
      if (track.style.transform === initial) {
        looped = true;
        break;
      }
    }

    expect(looped).toBe(true);
    expect(track.style.transform).toBe(initial);
  });
});

describe("carousel.js — indicator clicks", () => {
  it("clicking second indicator moves carousel forward", () => {
    const indicators = document.querySelectorAll<HTMLElement>(
      ".carousel-indicator",
    );
    const track = document.querySelector(".carousel-track") as HTMLElement;
    const initial = track.style.transform;

    if (indicators.length > 1) {
      indicators[1].click();
      expect(track.style.transform).not.toBe(initial);
    }
  });

  it("clicking first indicator keeps or returns to initial position", () => {
    const indicators = document.querySelectorAll<HTMLElement>(
      ".carousel-indicator",
    );
    const track = document.querySelector(".carousel-track") as HTMLElement;

    // Advance first
    document.querySelector<HTMLButtonElement>(".carousel-btn-next")!.click();

    // Go back to beginning via indicator 0
    indicators[0].click();
    expect(track.style.transform).toBe("translateX(0px)");
  });
});

describe("carousel.js — touch / swipe", () => {
  it("swipe left (startX > endX, diff > threshold) triggers next slide", () => {
    const track = document.querySelector(".carousel-track") as HTMLElement;
    const initial = track.style.transform;

    track.dispatchEvent(
      new TouchEvent("touchstart", {
        changedTouches: [{ screenX: 300 } as Touch],
      }),
    );
    track.dispatchEvent(
      new TouchEvent("touchend", {
        changedTouches: [{ screenX: 100 } as Touch],
      }),
    );

    expect(track.style.transform).not.toBe(initial);
  });

  it("swipe right (startX < endX, diff > threshold) triggers prev slide", () => {
    const track = document.querySelector(".carousel-track") as HTMLElement;

    // Move to slide 2 first so prev has somewhere to go
    document.querySelector<HTMLButtonElement>(".carousel-btn-next")!.click();
    const afterNext = track.style.transform;

    track.dispatchEvent(
      new TouchEvent("touchstart", {
        changedTouches: [{ screenX: 100 } as Touch],
      }),
    );
    track.dispatchEvent(
      new TouchEvent("touchend", {
        changedTouches: [{ screenX: 300 } as Touch],
      }),
    );

    expect(track.style.transform).not.toBe(afterNext);
  });

  it("small swipe below 50 px threshold does NOT change slide", () => {
    const track = document.querySelector(".carousel-track") as HTMLElement;
    const initial = track.style.transform;

    track.dispatchEvent(
      new TouchEvent("touchstart", {
        changedTouches: [{ screenX: 100 } as Touch],
      }),
    );
    track.dispatchEvent(
      new TouchEvent("touchend", {
        changedTouches: [{ screenX: 120 } as Touch], // only 20 px diff
      }),
    );

    expect(track.style.transform).toBe(initial);
  });
});

describe("carousel.js — keyboard navigation", () => {
  it("ArrowRight key advances to next slide", () => {
    const track = document.querySelector(".carousel-track") as HTMLElement;
    const carousel = document.querySelector(
      ".featured-games-carousel",
    ) as HTMLElement;
    const initial = track.style.transform;

    carousel.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));

    expect(track.style.transform).not.toBe(initial);
  });

  it("ArrowLeft key goes to previous slide", () => {
    const track = document.querySelector(".carousel-track") as HTMLElement;
    const carousel = document.querySelector(
      ".featured-games-carousel",
    ) as HTMLElement;

    // Advance first so prev has effect
    document.querySelector<HTMLButtonElement>(".carousel-btn-next")!.click();
    const afterNext = track.style.transform;

    carousel.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));

    expect(track.style.transform).not.toBe(afterNext);
  });

  /**
   * ArrowLeft and ArrowRight also scroll the page, and a horizontal scroll is
   * the one the browser keeps — so the slide moved and the whole page slid
   * sideways with it.
   */
  it.each(["ArrowLeft", "ArrowRight"])("takes %s for itself", (key) => {
    const carousel = document.querySelector(
      ".featured-games-carousel",
    ) as HTMLElement;

    const event = new KeyboardEvent("keydown", { key, cancelable: true });
    carousel.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  /**
   * A field inside the carousel owns its own arrow keys: they move the caret,
   * or change the value of a <select>. Stealing them to move the slide is not
   * something the visitor asked for — the search field in a slide's own form
   * is the case.
   */
  it.each(["input", "textarea", "select"])(
    "leaves the arrow keys to a <%s> inside it",
    (tag) => {
      const carousel = document.querySelector(
        ".featured-games-carousel",
      ) as HTMLElement;
      const field = document.createElement(tag);
      carousel.appendChild(field);

      const track = document.querySelector(".carousel-track") as HTMLElement;
      const initial = track.style.transform;

      const event = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      field.dispatchEvent(event);

      expect(track.style.transform).toBe(initial);
      expect(event.defaultPrevented).toBe(false);
    },
  );
});

describe("carousel.js — autoplay", () => {
  it("autoplay advances the slide after 5 s", () => {
    const track = document.querySelector(".carousel-track") as HTMLElement;
    const initial = track.style.transform;

    vi.advanceTimersByTime(5000);

    expect(track.style.transform).not.toBe(initial);
  });

  it("pauses autoplay on mouseenter so slide does not advance", () => {
    const carousel = document.querySelector(
      ".featured-games-carousel",
    ) as HTMLElement;
    const track = document.querySelector(".carousel-track") as HTMLElement;

    carousel.dispatchEvent(new Event("mouseenter"));
    const posAfterPause = track.style.transform;

    vi.advanceTimersByTime(5000);

    expect(track.style.transform).toBe(posAfterPause);
  });

  it("resumes autoplay on mouseleave and slide advances", () => {
    const carousel = document.querySelector(
      ".featured-games-carousel",
    ) as HTMLElement;
    const track = document.querySelector(".carousel-track") as HTMLElement;

    carousel.dispatchEvent(new Event("mouseenter"));
    const posAfterPause = track.style.transform;

    carousel.dispatchEvent(new Event("mouseleave"));
    vi.advanceTimersByTime(5000);

    expect(track.style.transform).not.toBe(posAfterPause);
  });

  /**
   * The keyboard's version of hovering.
   *
   * Only the pointer paused it, so a visitor tabbing through the slides was
   * reading a carousel that moved out from under them every five seconds —
   * and the slide holding focus is the one updateSlideVisibility is forbidden
   * to make inert, so the tab order silently disagreed with what was on
   * screen for as long as it was scrolled away.
   */
  it("pauses autoplay while focus is inside the carousel", () => {
    const carousel = document.querySelector(
      ".featured-games-carousel",
    ) as HTMLElement;
    const track = document.querySelector(".carousel-track") as HTMLElement;

    carousel.dispatchEvent(new Event("focusin", { bubbles: true }));
    const posAfterPause = track.style.transform;

    vi.advanceTimersByTime(5000);

    expect(track.style.transform).toBe(posAfterPause);
  });

  it("resumes once focus has left the carousel", () => {
    const carousel = document.querySelector(
      ".featured-games-carousel",
    ) as HTMLElement;
    const track = document.querySelector(".carousel-track") as HTMLElement;

    carousel.dispatchEvent(new Event("focusin", { bubbles: true }));
    const posAfterPause = track.style.transform;

    carousel.dispatchEvent(new Event("focusout", { bubbles: true }));
    // The handler defers to a timeout so the browser has settled the new
    // activeElement — nothing in the document has focus here, which is the
    // case it is looking for.
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(5000);

    expect(track.style.transform).not.toBe(posAfterPause);
  });

  /**
   * Focus moving from one slide to the next is a focusout too, and it is not
   * a reason to start the carousel moving under the element that is about to
   * receive it.
   */
  it("stays paused while focus only moves within the carousel", () => {
    const carousel = document.querySelector(
      ".featured-games-carousel",
    ) as HTMLElement;
    const track = document.querySelector(".carousel-track") as HTMLElement;
    const button = carousel.querySelector(
      ".carousel-btn-next",
    ) as HTMLButtonElement;

    carousel.dispatchEvent(new Event("focusin", { bubbles: true }));
    const posAfterPause = track.style.transform;

    button.focus();
    carousel.dispatchEvent(new Event("focusout", { bubbles: true }));
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(5000);

    expect(track.style.transform).toBe(posAfterPause);
  });

  /** document.hidden has no setter; jsdom lets it be redefined. */
  function setHidden(hidden: boolean) {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
  }

  /** Away and back again, which is the pair of events the handler sees. */
  function switchAwayAndBack() {
    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
  }

  it("pauses autoplay when the browser tab becomes hidden", () => {
    const track = document.querySelector(".carousel-track") as HTMLElement;

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));

    const posWhileHidden = track.style.transform;
    vi.advanceTimersByTime(10000);
    expect(track.style.transform).toBe(posWhileHidden);

    setHidden(false);
  });

  it("resumes when the tab comes back and nothing is holding it", () => {
    const track = document.querySelector(".carousel-track") as HTMLElement;

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));

    const posWhileHidden = track.style.transform;

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(5000);

    expect(track.style.transform).not.toBe(posWhileHidden);
  });

  /**
   * The two pauses the tab switch used to walk straight through.
   *
   * This branch called startAutoplay unconditionally, while mouseleave and
   * focusout both check the other reason before restarting. So a visitor who
   * had stopped the carousel by resting the pointer on it, or by tabbing into
   * a slide, switched to another tab and back and found it moving again —
   * with the pointer still on it, or with focus still inside the slide that
   * updateSlideVisibility is forbidden to make inert.
   */
  it("stays paused on return while the pointer is still on it", () => {
    const carousel = document.querySelector(
      ".featured-games-carousel",
    ) as HTMLElement;
    const track = document.querySelector(".carousel-track") as HTMLElement;

    carousel.dispatchEvent(new Event("mouseenter"));

    const posAfterPause = track.style.transform;

    switchAwayAndBack();
    vi.advanceTimersByTime(10000);

    expect(track.style.transform).toBe(posAfterPause);

    setHidden(false);
  });

  it("stays paused on return while focus is still inside it", () => {
    const carousel = document.querySelector(
      ".featured-games-carousel",
    ) as HTMLElement;
    const track = document.querySelector(".carousel-track") as HTMLElement;
    const button = carousel.querySelector(
      ".carousel-btn-next",
    ) as HTMLButtonElement;

    button.focus();
    carousel.dispatchEvent(new Event("focusin", { bubbles: true }));

    const posAfterPause = track.style.transform;

    switchAwayAndBack();
    vi.advanceTimersByTime(10000);

    expect(track.style.transform).toBe(posAfterPause);

    button.blur();
    setHidden(false);
  });
});

/**
 * A navigation is not a reason to start moving again.
 *
 * Prev and Next, the dots, the arrow keys and a swipe all go through
 * resetAutoplay, and startAutoplay used to ask only about the pause button —
 * so the press a keyboard visitor made with focus inside the carousel, or the
 * click a mouse visitor made with the pointer resting on it, restarted the
 * very timer focusin and mouseenter had just stopped. Five seconds later the
 * track moved under somebody who was still reading it (WCAG 2.2.2). The
 * reviewer's reproduction: no interval after focusin, one again after a click
 * on Next with focus still on it, and the next tick moved the track.
 */
describe("carousel.js — navigating does not restart a held autoplay", () => {
  const carousel = () =>
    document.querySelector(".featured-games-carousel") as HTMLElement;
  const track = () => document.querySelector(".carousel-track") as HTMLElement;
  const next = () =>
    document.querySelector(".carousel-btn-next") as HTMLButtonElement;

  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  it.each([
    ["the Next button", () => next().click()],
    [
      "the Prev button",
      () =>
        (document.querySelector(".carousel-btn-prev") as HTMLButtonElement).click(),
    ],
    [
      "a dot",
      () => document.querySelectorAll<HTMLElement>(".carousel-indicator")[2]!.click(),
    ],
    [
      "an arrow key",
      () =>
        carousel().dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight" }),
        ),
    ],
  ])("stays still after %s while focus is inside", (_how, navigate) => {
    // jsdom fires focusin for this, which is what stops the autoplay.
    next().focus();

    navigate();

    const whereTheVisitorPutIt = track().style.transform;

    vi.advanceTimersByTime(15_000);

    expect(track().style.transform).toBe(whereTheVisitorPutIt);
  });

  it("stays still after a click while the pointer rests on it", () => {
    carousel().dispatchEvent(new Event("mouseenter"));

    next().click();

    const whereTheVisitorPutIt = track().style.transform;

    vi.advanceTimersByTime(15_000);

    expect(track().style.transform).toBe(whereTheVisitorPutIt);
  });

  it("stays still after a swipe while focus is inside", () => {
    next().focus();

    track().dispatchEvent(
      new TouchEvent("touchstart", {
        changedTouches: [{ screenX: 300 } as Touch],
      }),
    );
    track().dispatchEvent(
      new TouchEvent("touchend", {
        changedTouches: [{ screenX: 100 } as Touch],
      }),
    );

    const whereTheVisitorPutIt = track().style.transform;

    vi.advanceTimersByTime(15_000);

    expect(track().style.transform).toBe(whereTheVisitorPutIt);
  });

  // Held for as long as the visitor is there, and not a moment longer: the
  // pointer leaving is the release mouseleave has always been.
  it("moves on again once the pointer has left", () => {
    carousel().dispatchEvent(new Event("mouseenter"));
    next().click();
    carousel().dispatchEvent(new Event("mouseleave"));

    const afterTheClick = track().style.transform;

    vi.advanceTimersByTime(5_000);

    expect(track().style.transform).not.toBe(afterTheClick);
  });

  // A swipe ends with the finger off the glass and nothing focused, so
  // nothing is holding it — touchend restarting it is the touch version of
  // mouseleave, and it has to survive the fix.
  it("still moves on after a swipe with nothing holding it", () => {
    track().dispatchEvent(
      new TouchEvent("touchstart", {
        changedTouches: [{ screenX: 300 } as Touch],
      }),
    );
    track().dispatchEvent(
      new TouchEvent("touchend", {
        changedTouches: [{ screenX: 100 } as Touch],
      }),
    );

    const afterTheSwipe = track().style.transform;

    vi.advanceTimersByTime(5_000);

    expect(track().style.transform).not.toBe(afterTheSwipe);
  });
});

/**
 * The track is moved in pixels, and a pixel offset is only right at the width
 * it was measured for.
 *
 * The resize handler re-measured only when the number of slides per view
 * changed, so a phone turned from portrait to landscape — one slide per view
 * either way — kept the offset of the old width. The reviewer's case: slide 3
 * of a 360px-wide carousel sat at -560px on a 740px one, where it belongs at
 * -1320px, stranded between two slides until the next navigation, and for
 * good with the autoplay paused or reduced motion on.
 */
describe("carousel.js — resizing", () => {
  let slideWidth = 200;

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        return slideWidth;
      },
    });
  });

  afterEach(() => {
    // Back to the fixed 200px the rest of this file measures against.
    slideWidth = 200;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
  });

  /** A resize the way the browser reports one, and the debounce run out. */
  function resizeTo(innerWidth: number, newSlideWidth: number) {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: innerWidth,
    });
    slideWidth = newSlideWidth;
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(200);
  }

  const track = () => document.querySelector(".carousel-track") as HTMLElement;
  const next = () =>
    document.querySelector(".carousel-btn-next") as HTMLButtonElement;

  it("re-measures when the width changes but the slides per view do not", () => {
    next().click();
    next().click();

    expect(track().style.transform).toBe("translateX(-400px)");

    // jsdom starts at 1024, two per view; 900 is still two.
    resizeTo(900, 300);

    expect(track().style.transform).toBe("translateX(-600px)");
  });

  it("still re-measures when the slides per view change", () => {
    next().click();

    resizeTo(600, 520);

    expect(track().style.transform).toBe("translateX(-520px)");
  });

  // A resize is a re-layout rather than a move the visitor asked for, and
  // now that every one of them is corrected, animating each would slide the
  // whole track across the screen on every turn of the phone.
  it("corrects the offset without animating it", () => {
    next().click();

    expect(track().style.transition).not.toBe("none");

    resizeTo(900, 300);

    expect(track().style.transition).toBe("none");
  });
});

/**
 * Moving content a visitor can stop (WCAG 2.2.2). Hover was the only pause,
 * which touch and keyboard users never trigger, and the slide animated
 * regardless of prefers-reduced-motion.
 */
describe("carousel.js — pause control and reduced motion", () => {
  function buildWithPause(slideCount = 6): string {
    const slides = Array.from(
      { length: slideCount },
      (_, i) => `<div class="carousel-slide" style="width:200px">Slide ${i + 1}</div>`,
    ).join("");

    return `
      <section class="featured-games-carousel" tabindex="0">
        <div class="carousel-track" style="gap:0px">${slides}</div>
        <button class="carousel-btn-prev">Prev</button>
        <button class="carousel-btn-next">Next</button>
        <div class="carousel-indicators">
          <button class="carousel-btn carousel-btn-pause" type="button" aria-label="Pause autoplay">
            <span class="carousel-pause-icon" aria-hidden="true">❚❚</span>
          </button>
        </div>
      </section>
    `;
  }

  function mount(reduceMotion = false) {
    if (reduceMotion) {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query.includes("reduce"),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }));
    } else {
      vi.stubGlobal("matchMedia", undefined);
    }

    document.body.innerHTML = buildWithPause();
    document.dispatchEvent(new Event("DOMContentLoaded"));

    return {
      track: document.querySelector(".carousel-track") as HTMLElement,
      pause: document.querySelector(".carousel-btn-pause") as HTMLButtonElement,
      icon: document.querySelector(".carousel-pause-icon") as HTMLElement,
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The name says what pressing the button will do, and nothing else says
   * anything about it. It used to swap the name *and* set aria-pressed, so a
   * paused carousel was announced "Resume autoplay, toggle button, pressed" —
   * pressed reads as "on", the words said it was off.
   */
  it("stops the autoplay when the pause button is pressed", () => {
    const { track, pause } = mount();
    const initial = track.style.transform;

    pause.click();
    vi.advanceTimersByTime(10_000);

    expect(track.style.transform).toBe(initial);
    expect(pause.getAttribute("aria-label")).toBe("Resume autoplay");
    expect(pause.hasAttribute("aria-pressed")).toBe(false);
  });

  it("resumes when pressed again", () => {
    const { track, pause } = mount();
    const initial = track.style.transform;

    pause.click();
    pause.click();
    vi.advanceTimersByTime(5_000);

    expect(track.style.transform).not.toBe(initial);
    expect(pause.getAttribute("aria-label")).toBe("Pause autoplay");
    expect(pause.hasAttribute("aria-pressed")).toBe(false);
  });

  /**
   * The pause button sits inside the carousel, so the visitor pressing it is
   * always "inside" — the pointer is on it, and focus is on it wherever a
   * click focuses a button. startAutoplay declines for exactly that now, and
   * "Resume autoplay" must not: it is the one request to move that the
   * visitor makes on purpose. The WAI-ARIA carousel pattern says the same —
   * rotation stopped by focus resumes when the rotation control is used.
   */
  it("resumes from the button with the pointer and focus on it", () => {
    const { track, pause } = mount();
    const carousel = document.querySelector(
      ".featured-games-carousel",
    ) as HTMLElement;

    carousel.dispatchEvent(new Event("mouseenter"));
    pause.focus();
    pause.click();

    const whilePaused = track.style.transform;

    pause.click();
    vi.advanceTimersByTime(5_000);

    expect(track.style.transform).not.toBe(whilePaused);

    pause.blur();
  });

  // Markup rendered before the view dropped the attribute — a cached page —
  // must not keep announcing a toggle the script no longer maintains.
  it("clears an aria-pressed that the markup still carries", () => {
    vi.stubGlobal("matchMedia", undefined);
    document.body.innerHTML = buildWithPause().replace(
      'aria-label="Pause autoplay"',
      'aria-label="Pause autoplay" aria-pressed="false"',
    );
    document.dispatchEvent(new Event("DOMContentLoaded"));

    const pause = document.querySelector(".carousel-btn-pause") as HTMLButtonElement;

    expect(pause.hasAttribute("aria-pressed")).toBe(false);

    pause.click();

    expect(pause.hasAttribute("aria-pressed")).toBe(false);
  });

  it("ships the button without aria-pressed in the view", () => {
    const view = readFileSync(
      path.resolve(__dirname, "../../views/featured-games-carousel.ejs"),
      "utf-8",
    );
    const button = /<button class="carousel-btn carousel-btn-pause"[^>]*>/.exec(view);

    expect(button).not.toBeNull();
    expect(button![0]).toContain('aria-label="Pause autoplay"');
    expect(button![0]).not.toContain("aria-pressed");
  });

  it("does not let the pointer leaving restart a paused autoplay", () => {
    const { track, pause } = mount();
    const carousel = document.querySelector(".featured-games-carousel") as HTMLElement;
    const initial = track.style.transform;

    pause.click();
    carousel.dispatchEvent(new Event("mouseenter"));
    carousel.dispatchEvent(new Event("mouseleave"));
    vi.advanceTimersByTime(10_000);

    expect(track.style.transform).toBe(initial);
  });

  it("swaps the icon between pause and play", () => {
    const { pause, icon } = mount();

    expect(icon.textContent).toBe("❚❚");
    pause.click();
    expect(icon.textContent).toBe("▶");
  });

  it("starts paused and unanimated under prefers-reduced-motion", () => {
    const { track, pause } = mount(true);
    const initial = track.style.transform;

    vi.advanceTimersByTime(10_000);

    expect(track.style.transform).toBe(initial);
    // Already paused, so the button offers to start it.
    expect(pause.getAttribute("aria-label")).toBe("Resume autoplay");
    expect(pause.hasAttribute("aria-pressed")).toBe(false);

    (document.querySelector(".carousel-btn-next") as HTMLButtonElement).click();

    expect(track.style.transition).toBe("none");
  });

  it("still works without a pause button in the markup", () => {
    vi.stubGlobal("matchMedia", undefined);
    document.body.innerHTML = buildWithPause().replace(/<button class="carousel-btn carousel-btn-pause"[\s\S]*?<\/button>/, "");

    expect(() => document.dispatchEvent(new Event("DOMContentLoaded"))).not.toThrow();
  });
});

/**
 * The slides the track has moved out of sight.
 *
 * The track is one long flex row shifted by a transform, so nothing was ever
 * removed from the page: tabbing through the carousel walked into game cards
 * that were not on screen, and a screen reader read all ten featured games
 * as though they were. `inert` takes them out of the tab order and out of the
 * accessibility tree at once.
 */
describe("carousel.js — slides out of view are inert", () => {
  function slides() {
    return Array.from(
      document.querySelectorAll<HTMLElement>(".carousel-slide"),
    );
  }

  // jsdom reports innerWidth 1024, which getSlidesPerView maps to two.
  const PER_VIEW = 2;

  it("leaves the visible window alone and closes the rest", () => {
    slides().forEach((slide, index) => {
      const visible = index < PER_VIEW;

      expect(
        slide.hasAttribute("inert"),
        `slide ${index} inert`,
      ).toBe(!visible);
      expect(slide.getAttribute("aria-hidden")).toBe(visible ? null : "true");
    });
  });

  it("moves the window with the carousel", () => {
    (
      document.querySelector(".carousel-btn-next") as HTMLButtonElement
    ).click();

    const [first, second, third] = slides();

    expect(first.hasAttribute("inert")).toBe(true);
    expect(second.hasAttribute("inert")).toBe(false);
    expect(third.hasAttribute("inert")).toBe(false);
  });

  it("opens a slide again when it scrolls back in", () => {
    const next = document.querySelector(
      ".carousel-btn-next",
    ) as HTMLButtonElement;
    const prev = document.querySelector(
      ".carousel-btn-prev",
    ) as HTMLButtonElement;

    next.click();
    expect(slides()[0].hasAttribute("inert")).toBe(true);

    prev.click();
    expect(slides()[0].hasAttribute("inert")).toBe(false);
    expect(slides()[0].getAttribute("aria-hidden")).toBeNull();
  });

  /**
   * Making the element that holds focus inert drops focus to <body>, which
   * is the very jump the attribute is here to prevent. The slide stays open
   * until focus has moved on — the focusout listener re-runs the sweep.
   */
  it("never closes the slide the visitor is focused inside", () => {
    document.body.innerHTML = `
      <section class="featured-games-carousel">
        <div class="carousel-track" style="gap:0px">
          <div class="carousel-slide"><a href="/a" id="a">A</a></div>
          <div class="carousel-slide"><a href="/b" id="b">B</a></div>
          <div class="carousel-slide"><a href="/c" id="c">C</a></div>
          <div class="carousel-slide"><a href="/d" id="d">D</a></div>
        </div>
        <button class="carousel-btn-prev">Prev</button>
        <button class="carousel-btn-next">Next</button>
      </section>
    `;
    document.dispatchEvent(new Event("DOMContentLoaded"));

    (document.getElementById("a") as HTMLAnchorElement).focus();
    (
      document.querySelector(".carousel-btn-next") as HTMLButtonElement
    ).click();

    expect(slides()[0].hasAttribute("inert")).toBe(false);
  });
});

/**
 * .active is a colour and nothing else; aria-current is the half a screen
 * reader can read. It is removed rather than set to "false" — the attribute
 * on every dot is the same as the attribute on none of them.
 */
describe("carousel.js — indicators announce the current slide", () => {
  function indicators() {
    return Array.from(
      document.querySelectorAll<HTMLElement>(".carousel-indicator"),
    );
  }

  it("marks exactly one dot as current", () => {
    const current = indicators().filter(
      (dot) => dot.getAttribute("aria-current") === "true",
    );

    expect(current).toHaveLength(1);
    expect(indicators()[0].getAttribute("aria-current")).toBe("true");
  });

  it("moves the mark with the carousel and mirrors .active", () => {
    (
      document.querySelector(".carousel-btn-next") as HTMLButtonElement
    ).click();

    const [first, second] = indicators();

    expect(first.getAttribute("aria-current")).toBeNull();
    expect(first.classList.contains("active")).toBe(false);
    expect(second.getAttribute("aria-current")).toBe("true");
    expect(second.classList.contains("active")).toBe(true);
  });

  it("carries no mark on a dot it has hidden as out of range", () => {
    const hidden = indicators().filter(
      (dot) => dot.style.display === "none",
    );

    expect(hidden.length).toBeGreaterThan(0);
    hidden.forEach((dot) =>
      expect(dot.getAttribute("aria-current")).toBeNull(),
    );
  });
});
