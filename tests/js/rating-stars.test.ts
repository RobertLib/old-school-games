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

beforeEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  (global as any).fetch = vi.fn();
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
      expect(star.getAttribute("aria-label")).toBe(`Rating ${i + 1} out of 5`);
    });
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

    await new Promise((r) => setTimeout(r, 20));

    expect(fetchMock).toHaveBeenCalledWith(
      "/games/42/rate",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
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

    await new Promise((r) => setTimeout(r, 20));

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.rating).toBe(3);
  });

  it("re-renders with the returned averageRating on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ averageRating: 5 }),
    });
    const el = await mountWithFetch(fetchMock as any);

    const stars = el.shadowRoot?.querySelectorAll<HTMLElement>(".star");
    stars?.[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 20));

    const selected = el.shadowRoot?.querySelectorAll(".star.selected");
    expect(selected?.length).toBe(5);
  });

  it("shows a success alert after rating", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ averageRating: 4 }),
    });
    const el = await mountWithFetch(fetchMock as any, 0, "7");

    const stars = el.shadowRoot?.querySelectorAll<HTMLElement>(".star");
    stars?.[3].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 20));

    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("stars"));
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

    await new Promise((r) => setTimeout(r, 20));

    expect(alertSpy).toHaveBeenCalledWith("Not logged in");
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

    await new Promise((r) => setTimeout(r, 20));

    expect(alertSpy).toHaveBeenCalledWith("Failed to submit rating.");
  });

  it("shows error alert on network failure", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
    const el = await mountWithFetch(fetchMock as any, 1, "5");

    const stars = el.shadowRoot?.querySelectorAll<HTMLElement>(".star");
    stars?.[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 20));

    expect(alertSpy).toHaveBeenCalledWith("Error submitting rating.");
  });
});
