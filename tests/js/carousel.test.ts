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
