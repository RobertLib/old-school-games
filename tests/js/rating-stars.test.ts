/**
 * @vitest-environment jsdom
 */
import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scriptContent = readFileSync(
  path.resolve(__dirname, "../../public/js/rating-stars.js"),
  "utf-8",
);

beforeAll(() => {
  // Indirect eval registers the custom element in the jsdom window
  // eslint-disable-next-line no-eval
  (0, eval)(scriptContent);
});

/**
 * Lets everything already queued settle, without waiting on the clock.
 *
 * The assertions in this file used to be preceded by a twenty-millisecond
 * sleep — a bet that twenty real milliseconds is always enough for a fetch
 * mock and the handlers chained onto it. It is, on a quiet laptop; it is the
 * first thing to go on a loaded CI runner, and it fails there as "expected
 * alert to have been called" rather than as a timeout, which sends the
 * reader looking at the component instead of at the clock.
 *
 * Everything that *should* happen is now waited for with `vi.waitFor`, which
 * retries until it does. This is for the other half — the assertions that
 * something did **not** happen, which `vi.waitFor` would pass instantly and
 * vacuously. Draining the microtask queue and yielding once to the macro
 * queue gives the work that was going to happen its chance to happen, in
 * whatever time it actually takes rather than a fixed twenty milliseconds.
 */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  (global as any).fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ratings: {} }),
  });
});

// ---------------------------------------------------------------------------

describe("rating-stars.js — custom element registration", () => {
  it("registers the 'rating-stars' custom element", () => {
    expect(customElements.get("rating-stars")).toBeDefined();
  });
});

describe("rating-stars.js — rendering", () => {
  async function mount(rating: number, gameId = "1"): Promise<HTMLElement> {
    const el = document.createElement("rating-stars");
    el.setAttribute("rating", String(rating));
    el.setAttribute("gameId", gameId);
    document.body.appendChild(el);
    // Allow microtasks to flush
    await Promise.resolve();
    return el;
  }

  it("renders exactly 5 star elements", async () => {
    const el = await mount(3);
    const stars = el.shadowRoot?.querySelectorAll(".star");
    expect(stars?.length).toBe(5);
  });

  it("marks the correct number of stars as selected for rating=3", async () => {
    const el = await mount(3);
    const selected = el.shadowRoot?.querySelectorAll(".star.selected");
    expect(selected?.length).toBe(3);
  });

  it("marks all 5 stars as selected for rating=5", async () => {
    const el = await mount(5);
    const selected = el.shadowRoot?.querySelectorAll(".star.selected");
    expect(selected?.length).toBe(5);
  });

  it("marks 0 stars as selected for rating=0", async () => {
    const el = await mount(0);
    const selected = el.shadowRoot?.querySelectorAll(".star.selected");
    expect(selected?.length).toBe(0);
  });

  it("treats a non-numeric rating attribute as 0 selected stars", async () => {
    const el = document.createElement("rating-stars");
    el.setAttribute("rating", "abc");
    el.setAttribute("gameId", "1");
    document.body.appendChild(el);
    await Promise.resolve();
    const selected = el.shadowRoot?.querySelectorAll(".star.selected");
    expect(selected?.length).toBe(0);
  });

  it("each star has correct aria-label", async () => {
    const el = await mount(2);
    const stars = el.shadowRoot?.querySelectorAll(".star");
    stars?.forEach((star, i) => {
      expect(star.getAttribute("aria-label")).toBe(`Rate ${i + 1} out of 5`);
    });
  });

  // Five identical buttons otherwise: a screen reader had no way to say
  // which of them was the visitor's own vote.
  it("marks the visitor's own vote with aria-pressed", async () => {
    const el = document.createElement("rating-stars");
    el.setAttribute("rating", "3");
    el.setAttribute("gameId", "1");
    el.setAttribute("userRating", "4");
    document.body.appendChild(el);
    await Promise.resolve();

    const pressed = Array.from(
      el.shadowRoot?.querySelectorAll(".star") ?? [],
    ).map((star) => star.getAttribute("aria-pressed"));

    expect(pressed).toEqual(["false", "false", "false", "true", "false"]);
  });

  it("presses no star when the visitor has not voted", async () => {
    const el = await mount(3);

    const pressed = Array.from(
      el.shadowRoot?.querySelectorAll(".star") ?? [],
    ).map((star) => star.getAttribute("aria-pressed"));

    expect(pressed).toEqual(["false", "false", "false", "false", "false"]);
  });

  /**
   * The visitor's stored votes are fetched once per page; a click that lands
   * before they arrive is a newer vote than the stored one. Writing the
   * stored one back over it showed the previous rating until a reload.
   */
  it("does not let a late stored vote overwrite a fresh one", async () => {
    let resolveStored!: (value: unknown) => void;
    const stored = new Promise((resolve) => {
      resolveStored = resolve;
    });

    (global as any).fetch = vi.fn((url: string) => {
      if (url === "/games/my-ratings") {
        return stored.then(() => ({
          ok: true,
          json: async () => ({ ratings: { "7": 2 } }),
        }));
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({ averageRating: 4.5, ratingCount: 3, userRating: 5 }),
      });
    });
    vi.spyOn(window, "alert").mockImplementation(() => {});

    const el = document.createElement("rating-stars");
    el.setAttribute("rating", "3");
    el.setAttribute("gameId", "7");
    document.body.appendChild(el);
    await Promise.resolve();

    (el.shadowRoot?.querySelectorAll(".star")[4] as HTMLElement).click();

    await vi.waitFor(() => {
      expect((el as any).userRating).toBe(5);
    });

    resolveStored(undefined);
    // Nothing is expected to change, so there is nothing to wait for — only
    // the stored vote's own handlers to be given their chance to run.
    await settle();

    expect((el as any).userRating).toBe(5);
    expect(el.shadowRoot?.querySelectorAll(".star.selected").length).toBe(5);
  });
});

describe("rating-stars.js — rating submission", () => {
  async function mountWithFetch(
    fetchImpl: typeof global.fetch,
    rating = 2,
    gameId = "42",
  ) {
    (global as any).fetch = fetchImpl;
    vi.spyOn(window, "alert").mockImplementation(() => {});

    const el = document.createElement("rating-stars");
    el.setAttribute("rating", String(rating));
    el.setAttribute("gameId", gameId);
    document.body.appendChild(el);
    await Promise.resolve();
    return el;
  }

  it("calls POST /games/:id/rate on star click", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ averageRating: 4 }),
    });
    const el = await mountWithFetch(fetchMock as any, 2, "42");

    const stars = el.shadowRoot?.querySelectorAll<HTMLElement>(".star");
    stars?.[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/games/42/rate",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
  });

  it("sends the clicked star index + 1 as the rating value", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ averageRating: 3 }),
    });
    const el = await mountWithFetch(fetchMock as any, 0, "10");

    const stars = el.shadowRoot?.querySelectorAll<HTMLElement>(".star");
    // Click the 3rd star (index 2 → rating 3)
    stars?.[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.rating).toBe(3);
  });

  it("shows the visitor's own vote back to them after rating", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        averageRating: 4.2,
        ratingCount: 9,
        userRating: 4,
      }),
    });
    const el = await mountWithFetch(fetchMock as any);

    const stars = el.shadowRoot?.querySelectorAll<HTMLElement>(".star");
    stars?.[3].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelectorAll(".star.selected").length).toBe(4);
      expect(el.shadowRoot?.querySelector(".summary")?.textContent).toContain(
        "your rating: 4/5",
      );
    });
  });

  it("does not interrupt with an alert on a successful rating", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ averageRating: 4, ratingCount: 3, userRating: 4 }),
    });
    const el = await mountWithFetch(fetchMock as any, 0, "7");

    const stars = el.shadowRoot?.querySelectorAll<HTMLElement>(".star");
    stars?.[3].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await settle();

    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("shows server error message when response is not ok", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Not logged in" }),
    });
    const el = await mountWithFetch(fetchMock as any, 1, "99");

    const stars = el.shadowRoot?.querySelectorAll<HTMLElement>(".star");
    stars?.[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith("Not logged in");
    });
  });

  it("shows fallback error message when response has no error field", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
    const el = await mountWithFetch(fetchMock as any, 1, "99");

    const stars = el.shadowRoot?.querySelectorAll<HTMLElement>(".star");
    stars?.[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith("Failed to submit rating.");
    });
  });

  it("shows error alert on network failure", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
    const el = await mountWithFetch(fetchMock as any, 1, "5");

    const stars = el.shadowRoot?.querySelectorAll<HTMLElement>(".star");
    stars?.[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith("Error submitting rating.");
    });
  });
});

describe("rating-stars.js — display details", () => {
  async function mount(attrs: Record<string, string>) {
    const el = document.createElement("rating-stars");
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    document.body.appendChild(el);
    await Promise.resolve();
    return el;
  }

  it("does not round a fractional average down to whole stars", async () => {
    const el = await mount({ rating: "4.8", gameId: "1", ratingCount: "10" });

    // 4.8 lights five stars, the last one partially — the old parseInt
    // showed four.
    expect(el.shadowRoot?.querySelectorAll(".star.selected").length).toBe(5);
  });

  it("shows the average and the number of votes", async () => {
    const el = await mount({ rating: "4.25", gameId: "1", ratingCount: "12" });

    expect(el.shadowRoot?.querySelector(".summary")?.textContent).toContain(
      "4.3 · 12 votes",
    );
  });

  it("uses the singular for a single vote", async () => {
    const el = await mount({ rating: "5", gameId: "1", ratingCount: "1" });

    expect(el.shadowRoot?.querySelector(".summary")?.textContent).toContain(
      "1 vote",
    );
  });

  it("says so when a game has no ratings", async () => {
    const el = await mount({ rating: "0", gameId: "1", ratingCount: "0" });

    expect(el.shadowRoot?.querySelector(".summary")?.textContent).toContain(
      "not rated yet",
    );
  });

  it("shows a server-rendered userRating straight away", async () => {
    const el = await mount({
      rating: "4.8",
      gameId: "1",
      ratingCount: "10",
      userRating: "2",
    });

    expect(el.shadowRoot?.querySelector(".summary")?.textContent).toContain(
      "your rating: 2/5",
    );
    expect(el.shadowRoot?.querySelectorAll(".star.selected").length).toBe(2);
  });

  it("ignores clicks when readonly", async () => {
    const fetchMock = vi.fn();
    (global as any).fetch = fetchMock;

    const el = await mount({ rating: "4", gameId: "1", readonly: "true" });

    el.shadowRoot
      ?.querySelector(".star")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Each star carries role="button" and tabindex="0", which puts it in the tab
 * order and announces it to a screen reader as a button. Only a click
 * listener stood behind that, so a visitor using the keyboard could tab onto
 * a star, see its focus ring, press Enter — and nothing happened at all.
 */
describe("rating-stars.js — keyboard activation", () => {
  async function mountWithFetch(fetchImpl: typeof global.fetch, gameId = "7") {
    (global as any).fetch = fetchImpl;
    vi.spyOn(window, "alert").mockImplementation(() => {});

    const el = document.createElement("rating-stars");
    el.setAttribute("rating", "0");
    el.setAttribute("gameId", gameId);
    document.body.appendChild(el);
    await Promise.resolve();
    return el;
  }

  function okFetch(rating: number) {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ averageRating: rating, ratingCount: 1 }),
    });
  }

  for (const key of ["Enter", " "]) {
    it(`submits the focused star's rating on ${JSON.stringify(key)}`, async () => {
      const fetchMock = okFetch(4);
      const el = await mountWithFetch(fetchMock as any, "7");

      const stars = el.shadowRoot?.querySelectorAll<HTMLElement>(".star");
      stars?.[3].dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/games/7/rate",
          expect.objectContaining({ method: "POST" }),
        );
      });

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      );
      expect(body.rating).toBe(4);
    });
  }

  it("ignores keys that are not Enter or Space", async () => {
    const fetchMock = okFetch(4);
    const el = await mountWithFetch(fetchMock as any);

    const stars = el.shadowRoot?.querySelectorAll<HTMLElement>(".star");
    stars?.[1].dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    stars?.[1].dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );

    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Space scrolls the page otherwise, which would move the stars out from
  // under the visitor at the moment they used them.
  it("prevents the default action for Space", async () => {
    const el = await mountWithFetch(okFetch(4) as any);

    const stars = el.shadowRoot?.querySelectorAll<HTMLElement>(".star");
    const event = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    stars?.[0].dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a keydown that came from outside a star alone", async () => {
    const fetchMock = okFetch(4);
    const el = await mountWithFetch(fetchMock as any);

    el.shadowRoot
      ?.querySelector(".stars")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * One set of listeners per element, however many times it is moved.
 *
 * connectedCallback runs again every time the element is re-inserted, and
 * this page re-inserts things constantly — favorites.js rebuilds the
 * collection lists, comments.js splices in rendered batches. Each re-entry
 * added a second click handler and a second keydown handler to the same
 * shadow root, so one tap on a star sent two votes. disconnectedCallback
 * takes them off again, which is what lets a genuine re-insert re-attach
 * exactly one of each.
 */
describe("rating-stars.js — listeners survive being moved, once", () => {
  async function mount(gameId = "42") {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ averageRating: 4, ratings: {} }),
    });

    (global as any).fetch = fetchMock;
    vi.spyOn(window, "alert").mockImplementation(() => {});

    const el = document.createElement("rating-stars");

    el.setAttribute("rating", "2");
    el.setAttribute("gameId", gameId);
    document.body.appendChild(el);
    await settle();

    return { el, fetchMock };
  }

  function clickThirdStar(el: Element) {
    el.shadowRoot
      ?.querySelectorAll<HTMLElement>(".star")[2]
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  function rateCalls(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/rate"),
    );
  }

  it("sends one vote after being detached and re-attached", async () => {
    const { el, fetchMock } = await mount();

    el.remove();
    document.body.appendChild(el);
    await settle();

    fetchMock.mockClear();
    clickThirdStar(el);
    await settle();

    expect(rateCalls(fetchMock)).toHaveLength(1);
  });

  it("still sends nothing once it has been taken off the page", async () => {
    const { el, fetchMock } = await mount();
    const shadow = el.shadowRoot!;

    el.remove();
    fetchMock.mockClear();

    shadow
      .querySelectorAll<HTMLElement>(".star")[2]
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(rateCalls(fetchMock)).toHaveLength(0);
  });

  it("keeps working normally when it is never moved", async () => {
    const { el, fetchMock } = await mount();

    fetchMock.mockClear();
    clickThirdStar(el);
    await settle();

    expect(rateCalls(fetchMock)).toHaveLength(1);
  });

  it("does not throw when disconnected twice", async () => {
    const { el } = await mount();

    el.remove();

    expect(() => (el as any).disconnectedCallback()).not.toThrow();
  });
});
