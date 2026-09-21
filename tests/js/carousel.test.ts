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

  it("pauses autoplay when the browser tab becomes hidden", () => {
    const track = document.querySelector(".carousel-track") as HTMLElement;

    // Set document.hidden to true
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    const posWhileHidden = track.style.transform;
    vi.advanceTimersByTime(10000);
    expect(track.style.transform).toBe(posWhileHidden);

    // Restore
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
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
          <button class="carousel-btn carousel-btn-pause" type="button" aria-label="Pause autoplay" aria-pressed="false">
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

  it("stops the autoplay when the pause button is pressed", () => {
    const { track, pause } = mount();
    const initial = track.style.transform;

    pause.click();
    vi.advanceTimersByTime(10_000);

    expect(track.style.transform).toBe(initial);
    expect(pause.getAttribute("aria-pressed")).toBe("true");
    expect(pause.getAttribute("aria-label")).toBe("Resume autoplay");
  });

  it("resumes when pressed again", () => {
    const { track, pause } = mount();
    const initial = track.style.transform;

    pause.click();
    pause.click();
    vi.advanceTimersByTime(5_000);

    expect(track.style.transform).not.toBe(initial);
    expect(pause.getAttribute("aria-pressed")).toBe("false");
    expect(pause.getAttribute("aria-label")).toBe("Pause autoplay");
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
    expect(pause.getAttribute("aria-pressed")).toBe("true");

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
