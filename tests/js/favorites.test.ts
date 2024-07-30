/**
 * @vitest-environment jsdom
 */
import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
// Pure — it imports nothing — so the unit project can reach it; see
// tests/unit-project-isolation.test.ts, which checks exactly that.
import { genreInSentence, genreLabel } from "../../utils/genre-label.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scriptContent = readFileSync(
  path.resolve(__dirname, "../../public/js/favorites.js"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Node.js 25 provides a native but non-functional localStorage global.
// Replace it with a full in-memory implementation so tests work correctly.
// ---------------------------------------------------------------------------
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
  // Indirect eval runs code in the global scope, making function declarations
  // available on globalThis (= window in jsdom)
  // eslint-disable-next-line no-eval
  (0, eval)(scriptContent);
});

beforeEach(() => {
  _lsStore.clear();
  _lsStore.set("favoriteGames", JSON.stringify([]));
  _lsStore.set("recentlyPlayedGames", JSON.stringify([]));
  document.body.innerHTML = "";
  // Each test is a fresh page load, so the hydration cache starts empty.
  window.invalidateCollectionCache();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeBtn(overrides: Record<string, string> = {}): HTMLButtonElement {
  const btn = document.createElement("button") as HTMLButtonElement;
  // Buttons now carry the id only — everything else comes from the server.
  const defaults: Record<string, string> = { gameId: "1" };
  Object.assign(btn.dataset, defaults, overrides);
  document.body.appendChild(btn);
  return btn;
}

/**
 * Lets everything already queued settle — the click handlers' re-renders,
 * the fetch mock inside each and the handlers chained onto it — without
 * betting on a clock. Draining the microtask queue and yielding once to the
 * macro queue gives the work that was going to happen its chance to, in
 * whatever time it actually takes.
 */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

declare const window: Window &
  typeof globalThis & {
    isFavorite: (id: string) => boolean;
    toggleFavorite: (btn: HTMLButtonElement) => void;
    updateFavoriteButton: (btn: HTMLButtonElement, liked: boolean) => void;
    updateFavoritesCount: () => void;
    addToRecentlyPlayed: (id: string) => void;
    removeFromRecentlyPlayed: (id: string) => void;
    loadFavoriteGames: () => Promise<void>;
    loadRecentlyPlayedGames: () => Promise<void>;
    loadContinuePlaying: () => Promise<void>;
    renderCollectionStats: () => Promise<void>;
    importCollection: (text: string) => {
      ok: boolean;
      message: string;
      saved: boolean;
    };
    invalidateCollectionCache: () => void;
    addGameToRecentlyPlayed: (id: string) => void;
    genreLabel: (genre: string) => string;
    genreInSentence: (genre: string) => string;
    genreWithArticle: (genre: string) => string;
  };

// ---------------------------------------------------------------------------

describe("favorites.js — isFavorite", () => {
  it("returns false when favorites list is empty", () => {
    expect(window.isFavorite("1")).toBe(false);
  });

  it("returns true when game is in favorites", () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "42", title: "Doom" }]),
    );
    expect(window.isFavorite("42")).toBe(true);
  });

  it("returns false for a different id", () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "42", title: "Doom" }]),
    );
    expect(window.isFavorite("99")).toBe(false);
  });

  it("returns false when favoriteGames key is missing from localStorage", () => {
    localStorage.removeItem("favoriteGames");
    expect(window.isFavorite("1")).toBe(false);
  });
});

describe("favorites.js — updateFavoritesCount", () => {
  it("hides count element when favorites list is empty", () => {
    document.body.innerHTML = '<span id="favorites-count">5</span>';
    window.updateFavoritesCount();
    const el = document.getElementById("favorites-count")!;
    expect(el.style.display).toBe("none");
  });

  it("shows count and correct number when favorites exist", () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "1" }, { id: "2" }]),
    );
    document.body.innerHTML = '<span id="favorites-count">0</span>';
    window.updateFavoritesCount();
    const el = document.getElementById("favorites-count")!;
    expect(el.textContent).toBe("2");
    expect(el.style.display).toBe("inline");
  });

  it("does not throw when count element is absent", () => {
    expect(() => window.updateFavoritesCount()).not.toThrow();
  });

  /**
   * The count is the profile link's only text — the icon beside it is an
   * <svg> with no title — so once a visitor had a favourite the link was
   * announced as a bare "3". The badge is aria-hidden in views/navbar.ejs and
   * the number belongs in the link's own name instead, where it is announced
   * as what it counts.
   */
  function mountProfileLink() {
    document.body.innerHTML = `
      <a href="/profile" aria-label="Profile">
        <span id="favorites-count" aria-hidden="true">0</span>
      </a>
    `;

    return document.querySelector("a")!;
  }

  it("names the link and what the number counts", () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "1" }, { id: "2" }, { id: "3" }]),
    );
    const link = mountProfileLink();

    window.updateFavoritesCount();

    expect(link.getAttribute("aria-label")).toBe("Profile, 3 favourites");
  });

  it("says it in the singular for one", () => {
    localStorage.setItem("favoriteGames", JSON.stringify([{ id: "1" }]));
    const link = mountProfileLink();

    window.updateFavoritesCount();

    expect(link.getAttribute("aria-label")).toBe("Profile, 1 favourite");
  });

  // Nothing to count, so nothing to say about it — the badge is hidden and
  // the link is just the link.
  it("leaves the plain name when there are none", () => {
    const link = mountProfileLink();

    window.updateFavoritesCount();

    expect(link.getAttribute("aria-label")).toBe("Profile");
  });
});

describe("favorites.js — updateFavoriteButton", () => {
  it("adds 'liked' class and fills heart when liked=true", () => {
    const btn = makeBtn();
    window.updateFavoriteButton(btn, true);
    expect(btn.classList.contains("liked")).toBe(true);
  });

  it("removes 'liked' class and shows outline heart when liked=false", () => {
    const btn = makeBtn();
    btn.classList.add("liked");
    window.updateFavoriteButton(btn, false);
    expect(btn.classList.contains("liked")).toBe(false);
  });
});

describe("favorites.js — toggleFavorite", () => {
  it("adds game to favorites when not yet a favorite", () => {
    const btn = makeBtn({ gameId: "5", gameTitle: "Quake" });
    window.toggleFavorite(btn);
    const favorites: { id: string }[] = JSON.parse(
      localStorage.getItem("favoriteGames")!,
    );
    expect(favorites.some((g) => g.id === "5")).toBe(true);
  });

  it("removes game from favorites when already a favorite", () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "5", title: "Quake" }]),
    );
    const btn = makeBtn({ gameId: "5" });
    window.toggleFavorite(btn);
    const favorites: { id: string }[] = JSON.parse(
      localStorage.getItem("favoriteGames")!,
    );
    expect(favorites.some((g) => g.id === "5")).toBe(false);
  });

  it("updates button appearance after toggling on", () => {
    const btn = makeBtn({ gameId: "7" });
    window.toggleFavorite(btn);
    expect(btn.classList.contains("liked")).toBe(true);
  });

  it("updates button appearance after toggling off", () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "7", title: "X" }]),
    );
    const btn = makeBtn({ gameId: "7" });
    window.toggleFavorite(btn);
    expect(btn.classList.contains("liked")).toBe(false);
  });
});

/**
 * Two tabs, one collection.
 *
 * localStorage is shared by every tab on the site, and a heart drawn before
 * another tab changed it goes on showing what was true then. The press used
 * to be decided from storage rather than from the heart, so favouriting a
 * game in tab B and then pressing its still-empty heart in tab A — asking to
 * add it — found it "already a favourite" and removed it: the reviewer's
 * reproduction went from [{id:"5"}] to [] with aria-pressed left at false.
 * Nothing listened for the other tab's write either, which is how the heart
 * came to be stale in the first place.
 */
describe("favorites.js — a heart another tab has made stale", () => {
  const storedIds = () =>
    JSON.parse(localStorage.getItem("favoriteGames")!).map(
      (entry: { id: string }) => entry.id,
    );

  function drawnHeart(pressed: boolean) {
    document.body.innerHTML = `
      <a href="/profile" aria-label="Profile">
        <span id="favorites-count" aria-hidden="true"></span>
      </a>
      <button class="favorite-btn" type="button" data-game-id="5"
              data-title="Doom"></button>
    `;

    const heart = document.querySelector(".favorite-btn") as HTMLButtonElement;

    window.updateFavoriteButton(heart, pressed);

    return heart;
  }

  /** What the browser delivers to this tab when another one writes. */
  function anotherTabWrites(key: string | null, list?: { id: string }[]) {
    if (key === null) {
      _lsStore.clear();
    } else {
      localStorage.setItem(key, JSON.stringify(list));
    }

    window.dispatchEvent(new StorageEvent("storage", { key }));
  }

  it("adds the game when its empty heart is pressed, whatever storage says", () => {
    const heart = drawnHeart(false);

    // Tab B, before the storage event has reached this one.
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "5", addedAt: "2026-09-23T00:00:00.000Z" }]),
    );

    window.toggleFavorite(heart);

    expect(heart.getAttribute("aria-pressed")).toBe("true");
    // Kept, and kept once.
    expect(storedIds()).toEqual(["5"]);
  });

  it("removes the game when its full heart is pressed, whatever storage says", () => {
    const heart = drawnHeart(true);

    // Tab B took it out already; pressing the full heart asks for the same.
    localStorage.setItem("favoriteGames", JSON.stringify([]));

    window.toggleFavorite(heart);

    expect(heart.getAttribute("aria-pressed")).toBe("false");
    expect(storedIds()).toEqual([]);
  });

  it("follows another tab's favourite without being pressed", () => {
    const heart = drawnHeart(false);

    anotherTabWrites("favoriteGames", [{ id: "5" }]);

    expect(heart.getAttribute("aria-pressed")).toBe("true");
    expect(heart.getAttribute("aria-label")).toBe("Remove Doom from favorites");
  });

  it("brings the navbar badge along with it", () => {
    drawnHeart(false);

    anotherTabWrites("favoriteGames", [{ id: "5" }, { id: "6" }]);

    expect(document.getElementById("favorites-count")!.textContent).toBe("2");
    expect(document.querySelector("a")!.getAttribute("aria-label")).toBe(
      "Profile, 2 favourites",
    );
  });

  // localStorage.clear() elsewhere — or the browser's own "clear site data" —
  // arrives with no key at all, and takes the favourites with it.
  it("follows the storage being cleared in another tab", () => {
    localStorage.setItem("favoriteGames", JSON.stringify([{ id: "5" }]));
    const heart = drawnHeart(true);

    anotherTabWrites(null);

    expect(heart.getAttribute("aria-pressed")).toBe("false");
    expect(document.getElementById("favorites-count")!.style.display).toBe(
      "none",
    );
  });

  it("ignores writes to keys that are not the collection", () => {
    const heart = drawnHeart(true);
    const spy = vi.spyOn(localStorage, "getItem");

    anotherTabWrites("theme", []);

    expect(spy).not.toHaveBeenCalled();
    expect(heart.getAttribute("aria-pressed")).toBe("true");

    spy.mockRestore();
  });

  // The profile's own hearts sit in cards drawn from the stored list, so the
  // list is what follows the other tab: a card whose game it removed goes,
  // rather than staying on with an empty heart.
  it("redraws the profile's lists from what the other tab stored", async () => {
    localStorage.setItem("favoriteGames", JSON.stringify([{ id: "1" }]));
    mockCollection([DOOM, { ...DOOM, id: 2, title: "Quake", slug: "quake" }]);
    document.body.innerHTML = `
      <div id="collection-stats"></div>
      <div id="favorite-games-container"></div>
      <div id="recently-played-games-container"></div>
    `;

    await window.loadFavoriteGames();

    anotherTabWrites("favoriteGames", [{ id: "1" }, { id: "2" }]);
    await settle();

    const container = document.getElementById("favorite-games-container")!;

    expect(container.textContent).toContain("Quake");
    expect(
      container.querySelector('.favorite-btn[data-game-id="2"]'),
    ).not.toBeNull();
  });
});

describe("favorites.js — addToRecentlyPlayed / removeFromRecentlyPlayed", () => {
  it("adds game to recently played with a playedAt timestamp", () => {
    window.addToRecentlyPlayed("10");
    const list = JSON.parse(localStorage.getItem("recentlyPlayedGames")!);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("10");
    expect(list[0].playedAt).toBeDefined();
  });

  it("stores only the id, not a copy of the game", () => {
    window.addToRecentlyPlayed("10");
    const list = JSON.parse(localStorage.getItem("recentlyPlayedGames")!);
    expect(Object.keys(list[0]).sort()).toEqual(["id", "playedAt"]);
  });

  it("deduplicates — moves existing entry to front", () => {
    window.addToRecentlyPlayed("10");
    window.addToRecentlyPlayed("20");
    window.addToRecentlyPlayed("10");

    const list = JSON.parse(localStorage.getItem("recentlyPlayedGames")!);
    const ids = list.map((g: { id: string }) => g.id);
    expect(ids.filter((id: string) => id === "10").length).toBe(1);
    expect(ids[0]).toBe("10");
  });

  it("limits the recently played list to 20 entries", () => {
    for (let i = 0; i < 30; i++) {
      window.addToRecentlyPlayed(`${i}`);
    }
    const list = JSON.parse(localStorage.getItem("recentlyPlayedGames")!);
    expect(list.length).toBe(20);
  });

  it("removes a game from recently played by id", () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([{ id: "10" }]),
    );
    window.removeFromRecentlyPlayed("10");
    const list = JSON.parse(localStorage.getItem("recentlyPlayedGames")!);
    expect(list.some((g: { id: string }) => g.id === "10")).toBe(false);
  });

  it("leaves other entries intact when removing one", () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([{ id: "10" }, { id: "20" }]),
    );
    window.removeFromRecentlyPlayed("10");
    const list = JSON.parse(localStorage.getItem("recentlyPlayedGames")!);
    expect(list.some((g: { id: string }) => g.id === "20")).toBe(true);
  });
});

describe("favorites.js — legacy storage migration", () => {
  it("keeps ids from entries written in the old full-copy format", () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([
        { id: "1", title: "Doom", slug: "doom", image: "doom.jpg" },
      ]),
    );
    expect(window.isFavorite("1")).toBe(true);
  });

  it("drops the stale copied fields once the list is written back", () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([
        { id: "1", title: "Old Title", slug: "old-slug", image: "old.jpg" },
      ]),
    );

    const btn = makeBtn({ gameId: "2" });
    window.toggleFavorite(btn);

    const list = JSON.parse(localStorage.getItem("favoriteGames")!);
    expect(list[0].title).toBeUndefined();
    expect(list[0].slug).toBeUndefined();
    expect(list[0].id).toBe("1");
  });

  it("survives corrupted JSON in localStorage", () => {
    localStorage.setItem("favoriteGames", "{not json");
    expect(window.isFavorite("1")).toBe(false);
  });
});

describe("favorites.js — window.addGameToRecentlyPlayed (public API)", () => {
  it("delegates to addToRecentlyPlayed and stores the id", () => {
    window.addGameToRecentlyPlayed("42");
    const list = JSON.parse(localStorage.getItem("recentlyPlayedGames")!);
    expect(list.some((g: { id: string }) => g.id === "42")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rendering now hydrates from the server, so these mock /games/collection.
// ---------------------------------------------------------------------------

function mockCollection(games: Record<string, unknown>[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ games }),
  });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

const DOOM = {
  id: 1,
  title: "Doom",
  slug: "doom",
  genre: "SHOOTER",
  release: 1993,
  image: "doom.jpg",
  description: "Legendary FPS",
  averageRating: 4.9,
  ratingCount: 12,
};

describe("favorites.js — loadFavoriteGames", () => {
  it("renders empty-state message when no favorites", async () => {
    mockCollection([]);
    document.body.innerHTML = '<div id="favorite-games-container"></div>';

    await window.loadFavoriteGames();

    const container = document.getElementById("favorite-games-container")!;
    expect(container.textContent).toContain("No favourites yet");
  });

  it("renders game data fetched from the server, not from localStorage", async () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "1", title: "Stale Title", slug: "stale" }]),
    );
    mockCollection([DOOM]);
    document.body.innerHTML = '<div id="favorite-games-container"></div>';

    await window.loadFavoriteGames();

    const container = document.getElementById("favorite-games-container")!;
    expect(container.textContent).toContain("Doom");
    expect(container.textContent).not.toContain("Stale Title");
    expect(container.querySelector('a[href="/doom"]')).not.toBeNull();
  });

  /**
   * Keyboard focus survives the re-render.
   *
   * The list is rebuilt with replaceChildren, which destroys the element that
   * had focus — and the browser then drops focus to <body>. So pressing the
   * heart on a favourite removed it, redrew the list, and left a keyboard
   * visitor at the top of the document with the next Tab starting again from
   * the navbar.
   */
  it("puts focus back on the same heart after a re-render", async () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "1" }, { id: "2" }]),
    );
    mockCollection([DOOM, { ...DOOM, id: 2, title: "Quake", slug: "quake" }]);
    document.body.innerHTML = '<div id="favorite-games-container"></div>';

    await window.loadFavoriteGames();

    const container = document.getElementById("favorite-games-container")!;
    const first = container.querySelector<HTMLButtonElement>(
      '.favorite-btn[data-game-id="1"]',
    )!;

    first.focus();
    expect(document.activeElement).toBe(first);

    await window.loadFavoriteGames();

    const rebuilt = container.querySelector<HTMLButtonElement>(
      '.favorite-btn[data-game-id="1"]',
    )!;

    expect(rebuilt).not.toBe(first);
    expect(document.activeElement).toBe(rebuilt);
  });

  /**
   * The card that had focus is usually the one that was just removed, so
   * there is no equivalent of it to go back to — and focus used to go to the
   * container every time, because replacePreservingFocus looked for the
   * removed game's own id, the one id certain not to be there. It goes to the
   * card that took the removed one's place: the next one down, or, when the
   * last card went, the one above it.
   */
  it("moves focus up to the card above when the last one goes", async () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "1" }, { id: "2" }]),
    );
    mockCollection([DOOM, { ...DOOM, id: 2, title: "Quake", slug: "quake" }]);
    document.body.innerHTML = '<div id="favorite-games-container"></div>';

    await window.loadFavoriteGames();

    const container = document.getElementById("favorite-games-container")!;

    container
      .querySelector<HTMLButtonElement>('.favorite-btn[data-game-id="2"]')!
      .focus();

    localStorage.setItem("favoriteGames", JSON.stringify([{ id: "1" }]));
    window.invalidateCollectionCache();
    mockCollection([DOOM]);

    await window.loadFavoriteGames();

    expect(document.activeElement).toBe(
      container.querySelector('.favorite-btn[data-game-id="1"]'),
    );
  });

  it("moves focus to the heart of the card that took the removed one's place", async () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "1" }, { id: "2" }, { id: "3" }]),
    );
    mockCollection([
      DOOM,
      { ...DOOM, id: 2, title: "Quake", slug: "quake" },
      { ...DOOM, id: 3, title: "Heretic", slug: "heretic" },
    ]);
    document.body.innerHTML = '<div id="favorite-games-container"></div>';

    await window.loadFavoriteGames();

    const container = document.getElementById("favorite-games-container")!;
    const heart = container.querySelector<HTMLButtonElement>(
      '.favorite-btn[data-game-id="2"]',
    )!;

    heart.focus();
    heart.click();
    await settle();

    expect(container.querySelector('.favorite-btn[data-game-id="2"]')).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('.favorite-btn[data-game-id="3"]'),
    );
  });

  /**
   * The removal that empties the list is the one that goes through
   * renderEmpty, and renderEmpty called replaceChildren directly — so the
   * heart on the last favourite was the one press that still dropped focus
   * to <body>, which is exactly what replacePreservingFocus exists to stop.
   */
  it("keeps focus in the list when the last favourite is removed", async () => {
    localStorage.setItem("favoriteGames", JSON.stringify([{ id: "1" }]));
    mockCollection([DOOM]);
    document.body.innerHTML = '<div id="favorite-games-container"></div>';

    await window.loadFavoriteGames();

    const container = document.getElementById("favorite-games-container")!;
    const heart = container.querySelector<HTMLButtonElement>(
      '.favorite-btn[data-game-id="1"]',
    )!;

    heart.focus();
    heart.click();
    await settle();

    expect(container.textContent).toContain("No favourites yet");
    expect(document.activeElement).toBe(container);
  });

  // Nobody is dragged back to a list they had tabbed away from while the
  // request was in flight.
  it("leaves focus alone when it was outside the list", async () => {
    localStorage.setItem("favoriteGames", JSON.stringify([{ id: "1" }]));
    mockCollection([DOOM]);
    document.body.innerHTML =
      '<button id="elsewhere"></button><div id="favorite-games-container"></div>';

    const elsewhere = document.getElementById(
      "elsewhere",
    ) as HTMLButtonElement;

    elsewhere.focus();

    await window.loadFavoriteGames();

    expect(document.activeElement).toBe(elsewhere);
  });

  it("requests only the stored ids", async () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "1" }, { id: "2" }]),
    );
    const fetchMock = mockCollection([DOOM]);
    document.body.innerHTML = '<div id="favorite-games-container"></div>';

    await window.loadFavoriteGames();

    expect(fetchMock).toHaveBeenCalledWith("/games/collection?ids=1%2C2");
  });

  it("forgets entries whose game no longer exists", async () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "1" }, { id: "999" }]),
    );
    mockCollection([DOOM]);
    document.body.innerHTML = '<div id="favorite-games-container"></div>';

    await window.loadFavoriteGames();

    const list = JSON.parse(localStorage.getItem("favoriteGames")!);
    expect(list.map((entry: { id: string }) => entry.id)).toEqual(["1"]);
  });

  // /games/collection looks up at most 100 ids and says nothing about the rest
  // (see routes/games.ts). Asking for more in one request therefore came back
  // short, and the pruning above read the missing games as deleted ones — so
  // visiting this page with a long favourites list deleted everything past the
  // hundredth entry from the browser, for good.
  it("keeps every favourite when the list is longer than one request", async () => {
    const stored = Array.from({ length: 150 }, (_, index) => ({
      id: String(index + 1),
    }));

    localStorage.setItem("favoriteGames", JSON.stringify(stored));

    // Answers whatever each batch asked for, as the real endpoint does.
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const ids = decodeURIComponent(url.split("ids=")[1]!).split(",");

      return Promise.resolve({
        ok: true,
        json: async () => ({
          games: ids.map((id) => ({ ...DOOM, id: Number(id) })),
        }),
      });
    });
    (global as any).fetch = fetchMock;

    document.body.innerHTML = '<div id="favorite-games-container"></div>';

    await window.loadFavoriteGames();

    // Two requests of at most 100 ids, not one of 150.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const [url] of fetchMock.mock.calls) {
      const ids = decodeURIComponent(url.split("ids=")[1]!).split(",");
      expect(ids.length).toBeLessThanOrEqual(100);
    }

    const list = JSON.parse(localStorage.getItem("favoriteGames")!);
    expect(list).toHaveLength(150);
  });

  // One batch failing still leaves the others populated, which the old
  // "anything came back" test read as permission to prune.
  it("keeps the stored list when a lookup fails", async () => {
    const stored = Array.from({ length: 150 }, (_, index) => ({
      id: String(index + 1),
    }));

    localStorage.setItem("favoriteGames", JSON.stringify(stored));

    let call = 0;
    (global as any).fetch = vi.fn().mockImplementation((url: string) => {
      // The first batch answers; the second does not.
      if (call++ > 0) return Promise.reject(new Error("offline"));

      const ids = decodeURIComponent(url.split("ids=")[1]!).split(",");

      return Promise.resolve({
        ok: true,
        json: async () => ({
          games: ids.map((id) => ({ ...DOOM, id: Number(id) })),
        }),
      });
    });

    document.body.innerHTML = '<div id="favorite-games-container"></div>';

    await window.loadFavoriteGames();

    const list = JSON.parse(localStorage.getItem("favoriteGames")!);
    expect(list).toHaveLength(150);
  });

  // The mirror image: an answer that covers every id and reports none of them
  // is the one case where emptying the list is correct. "size > 0" refused it,
  // so a list of nothing but deleted games could never clear itself.
  it("clears the list when every game is confirmed gone", async () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "1" }, { id: "2" }]),
    );
    mockCollection([]);
    document.body.innerHTML = '<div id="favorite-games-container"></div>';

    await window.loadFavoriteGames();

    expect(JSON.parse(localStorage.getItem("favoriteGames")!)).toEqual([]);
  });

  it("never injects server text as markup", async () => {
    localStorage.setItem("favoriteGames", JSON.stringify([{ id: "1" }]));
    mockCollection([
      {
        ...DOOM,
        title: '<script>alert("xss")</script>',
        description: '<img src="x" onerror="alert(1)">',
      },
    ]);
    document.body.innerHTML = '<div id="favorite-games-container"></div>';

    await window.loadFavoriteGames();

    const container = document.getElementById("favorite-games-container")!;
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.textContent).toContain("<script>");
    expect(container.textContent).toContain("<img");
  });

  /**
   * A cover the script builds and one the server renders are the same
   * picture on the same page, so they say the same thing about it. "Doom" on
   * its own reads as if the link were the word rather than the box art, and a
   * width with no height leaves the card to reflow once the file arrives —
   * views/games/game-item.ejs has carried both for years.
   */
  it("describes and sizes a cover the way the server does", async () => {
    localStorage.setItem("favoriteGames", JSON.stringify([{ id: "1" }]));
    mockCollection([DOOM]);
    document.body.innerHTML = '<div id="favorite-games-container"></div>';

    await window.loadFavoriteGames();

    const img = document
      .getElementById("favorite-games-container")!
      .querySelector("img")!;

    expect(img.getAttribute("alt")).toBe("Doom – MS-DOS cover art");
    expect(img.getAttribute("width")).toBe("100");
    expect(img.getAttribute("height")).toBe("127");
  });

  /**
   * The stats above the list count favourites, so removing one leaves them
   * stale. The recently-played list has always refreshed them from its own
   * remove button and this one did not.
   */
  it("refreshes the collection stats when a favourite is removed", async () => {
    localStorage.setItem("favoriteGames", JSON.stringify([{ id: "1" }]));
    mockCollection([DOOM]);
    document.body.innerHTML = `
      <div id="collection-stats"></div>
      <div id="favorite-games-container"></div>
    `;

    await window.loadFavoriteGames();
    await window.renderCollectionStats();

    expect(document.getElementById("collection-stats")!.textContent).toContain(
      "in favourites",
    );

    const remove = document
      .getElementById("favorite-games-container")!
      .querySelector<HTMLButtonElement>("button")!;

    remove.click();

    // Both re-renders are async; one microtask flush is not enough for the
    // fetch mock inside either of them.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(JSON.parse(localStorage.getItem("favoriteGames")!)).toEqual([]);
    // Nothing played and nothing favourited, so the stats clear themselves —
    // which they only do if they were asked to re-render at all.
    expect(document.getElementById("collection-stats")!.children).toHaveLength(
      0,
    );
  });

  it("does not throw when container element is absent", async () => {
    mockCollection([]);
    await expect(window.loadFavoriteGames()).resolves.toBeUndefined();
  });
});

describe("favorites.js — loadRecentlyPlayedGames", () => {
  it("renders empty-state message when no recently played games", async () => {
    mockCollection([]);
    document.body.innerHTML =
      '<div id="recently-played-games-container"></div>';

    await window.loadRecentlyPlayedGames();

    const container = document.getElementById(
      "recently-played-games-container",
    )!;
    expect(container.textContent).toContain("haven't played anything yet");
  });

  it("renders game items with the last played date", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([{ id: "1", playedAt: "2026-01-15T10:00:00.000Z" }]),
    );
    mockCollection([DOOM]);
    document.body.innerHTML =
      '<div id="recently-played-games-container"></div>';

    await window.loadRecentlyPlayedGames();

    const container = document.getElementById(
      "recently-played-games-container",
    )!;
    expect(container.textContent).toContain("Doom");
    expect(container.textContent).toContain("Last played:");
    expect(container.querySelector('a[href="/doom"]')).not.toBeNull();
  });

  /**
   * The same focus bug the favourites list above was fixed for, on the list
   * that was left behind.
   *
   * This one ended in replaceChildren, so pressing "Remove" destroyed the
   * button that had focus and the browser dropped focus to <body> — a keyboard
   * visitor was returned to the top of the document and the next Tab started
   * again from the navbar. The "Remove" button carries no heart, so it also
   * had to be given the data-game-id that replacePreservingFocus names a
   * button by; without it the match finds nothing and every removal falls
   * through to the container.
   */
  it("puts focus back on the same Remove button after a re-render", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([
        { id: "1", playedAt: "2026-01-15T10:00:00.000Z" },
        { id: "2", playedAt: "2026-01-14T10:00:00.000Z" },
      ]),
    );
    mockCollection([DOOM, { ...DOOM, id: 2, title: "Quake", slug: "quake" }]);
    document.body.innerHTML =
      '<div id="recently-played-games-container"></div>';

    await window.loadRecentlyPlayedGames();

    const container = document.getElementById(
      "recently-played-games-container",
    )!;
    const first = container.querySelector<HTMLButtonElement>(
      'button[data-game-id="1"]',
    )!;

    expect(first).not.toBeNull();

    first.focus();
    expect(document.activeElement).toBe(first);

    await window.loadRecentlyPlayedGames();

    const rebuilt = container.querySelector<HTMLButtonElement>(
      'button[data-game-id="1"]',
    )!;

    expect(rebuilt).not.toBe(first);
    expect(document.activeElement).toBe(rebuilt);
  });

  // The entry that had focus is the one that was just removed, so there is no
  // equivalent to return to; the card above it takes focus when it was the
  // last, rather than the container.
  it("moves focus up to the entry above when the last one goes", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([
        { id: "1", playedAt: "2026-01-15T10:00:00.000Z" },
        { id: "2", playedAt: "2026-01-14T10:00:00.000Z" },
      ]),
    );
    mockCollection([DOOM, { ...DOOM, id: 2, title: "Quake", slug: "quake" }]);
    document.body.innerHTML =
      '<div id="recently-played-games-container"></div>';

    await window.loadRecentlyPlayedGames();

    const container = document.getElementById(
      "recently-played-games-container",
    )!;

    container
      .querySelector<HTMLButtonElement>('button[data-game-id="2"]')!
      .focus();

    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([{ id: "1", playedAt: "2026-01-15T10:00:00.000Z" }]),
    );
    window.invalidateCollectionCache();
    mockCollection([DOOM]);

    await window.loadRecentlyPlayedGames();

    expect(document.activeElement).toBe(
      container.querySelector('button[data-game-id="1"]'),
    );
  });

  /**
   * The reviewer's case: "Remove" on the second of three. The comment on the
   * button said focus went "to the card that took this one's place", and it
   * went to the container — the match was on the removed game's own id.
   */
  it("moves focus to the Remove button of the card that took its place", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify(
        ["1", "2", "3"].map((id) => ({ id, playedAt: "2026-01-15T10:00:00.000Z" })),
      ),
    );
    mockCollection([
      DOOM,
      { ...DOOM, id: 2, title: "Quake", slug: "quake" },
      { ...DOOM, id: 3, title: "Heretic", slug: "heretic" },
    ]);
    document.body.innerHTML =
      '<div id="recently-played-games-container"></div>';

    await window.loadRecentlyPlayedGames();

    const container = document.getElementById(
      "recently-played-games-container",
    )!;
    const remove = container.querySelector<HTMLButtonElement>(
      'button[data-game-id="2"]',
    )!;

    remove.focus();
    remove.click();
    await settle();

    expect(container.querySelectorAll("article")).toHaveLength(2);
    expect(document.activeElement).toBe(
      container.querySelector('button[data-game-id="3"]'),
    );
  });

  // The same hole as the favourites' empty state: the last "Remove" went
  // through renderEmpty, which bypassed the focus-preserving swap.
  it("keeps focus in the list when the last game played is removed", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([{ id: "1", playedAt: "2026-01-15T10:00:00.000Z" }]),
    );
    mockCollection([DOOM]);
    document.body.innerHTML =
      '<div id="recently-played-games-container"></div>';

    await window.loadRecentlyPlayedGames();

    const container = document.getElementById(
      "recently-played-games-container",
    )!;
    const remove = container.querySelector<HTMLButtonElement>(
      'button[data-game-id="1"]',
    )!;

    remove.focus();
    remove.click();
    await settle();

    expect(container.textContent).toContain("haven't played anything yet");
    expect(document.activeElement).toBe(container);
  });

  // Nobody is dragged back to a list they had tabbed away from while the
  // request was in flight.
  it("leaves focus alone when it was outside the list", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([{ id: "1", playedAt: "2026-01-15T10:00:00.000Z" }]),
    );
    mockCollection([DOOM]);
    document.body.innerHTML =
      '<button id="elsewhere"></button><div id="recently-played-games-container"></div>';

    const elsewhere = document.getElementById(
      "elsewhere",
    ) as HTMLButtonElement;

    elsewhere.focus();

    await window.loadRecentlyPlayedGames();

    expect(document.activeElement).toBe(elsewhere);
  });

  it("does not throw when container element is absent", async () => {
    mockCollection([]);
    await expect(window.loadRecentlyPlayedGames()).resolves.toBeUndefined();
  });
});

/**
 * /games/collection not answering — offline, a 429, the database having a
 * bad minute.
 *
 * A failed lookup hydrates to an empty list, and an empty list is what the
 * empty state is drawn from, so the profile told somebody whose navbar badge
 * said 3 that they had "No favourites yet" and "haven't played anything yet":
 * it read as the collection having been lost. Nothing was — hydrate() only
 * prunes against a complete answer — and the lists now say so, with a way to
 * ask again.
 */
describe("favorites.js — when the collection cannot be looked up", () => {
  const stored = (key: string, ids: string[]) =>
    localStorage.setItem(key, JSON.stringify(ids.map((id) => ({ id }))));

  const unreachable = {
    offline: () => vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    "rate limited": () =>
      vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }),
    "a server error": () =>
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
  };

  function mountProfile() {
    document.body.innerHTML = `
      <div id="collection-stats"></div>
      <div id="favorite-games-container"></div>
      <div id="recently-played-games-container"></div>
    `;

    return {
      stats: document.getElementById("collection-stats")!,
      favourites: document.getElementById("favorite-games-container")!,
      played: document.getElementById("recently-played-games-container")!,
    };
  }

  it.each(Object.entries(unreachable))(
    "does not call the favourites empty when %s",
    async (_why, fetchImpl) => {
      stored("favoriteGames", ["1", "2", "3"]);
      (global as any).fetch = fetchImpl();
      const { favourites } = mountProfile();

      await window.loadFavoriteGames();

      expect(favourites.textContent).not.toContain("No favourites yet");
      expect(favourites.textContent).toContain("couldn't be loaded");
      expect(favourites.querySelector("button")!.textContent).toBe("Try again");
      // Nothing pruned, as before.
      expect(JSON.parse(localStorage.getItem("favoriteGames")!)).toHaveLength(3);
    },
  );

  it("does not call the recently-played list empty either", async () => {
    stored("recentlyPlayedGames", ["1"]);
    (global as any).fetch = unreachable.offline();
    const { played } = mountProfile();

    await window.loadRecentlyPlayedGames();

    expect(played.textContent).not.toContain("haven't played anything yet");
    expect(played.textContent).toContain("couldn't be loaded");
    expect(JSON.parse(localStorage.getItem("recentlyPlayedGames")!)).toHaveLength(1);
  });

  // One batch of two missing is still not the collection: shown half-drawn,
  // the list would read as having lost the rest.
  it("does not draw a list that is missing a batch", async () => {
    stored(
      "favoriteGames",
      Array.from({ length: 150 }, (_, index) => String(index + 1)),
    );

    let call = 0;
    (global as any).fetch = vi.fn().mockImplementation((url: string) => {
      if (call++ > 0) return Promise.reject(new TypeError("Failed to fetch"));

      const ids = decodeURIComponent(url.split("ids=")[1]!).split(",");

      return Promise.resolve({
        ok: true,
        json: async () => ({ games: ids.map((id) => ({ ...DOOM, id: Number(id) })) }),
      });
    });

    const { favourites } = mountProfile();

    await window.loadFavoriteGames();

    expect(favourites.querySelectorAll("article")).toHaveLength(0);
    expect(favourites.textContent).toContain("couldn't be loaded");
  });

  // "0 in favourites" beside a badge saying 3 is the same wrong claim again.
  it("draws no stats it could not count", async () => {
    stored("favoriteGames", ["1", "2", "3"]);
    (global as any).fetch = unreachable.offline();
    const { stats } = mountProfile();

    await window.renderCollectionStats();

    expect(stats.children).toHaveLength(0);
  });

  it("asks again, and draws the lists, when Try again is pressed", async () => {
    stored("favoriteGames", ["1"]);
    stored("recentlyPlayedGames", ["1"]);
    (global as any).fetch = unreachable.offline();
    const { favourites, played, stats } = mountProfile();

    await Promise.all([
      window.loadFavoriteGames(),
      window.loadRecentlyPlayedGames(),
      window.renderCollectionStats(),
    ]);

    const fetchMock = mockCollection([DOOM]);

    favourites.querySelector("button")!.click();
    await settle();

    // A new request rather than the failure handed back out of the cache.
    expect(fetchMock).toHaveBeenCalled();
    expect(favourites.textContent).toContain("Doom");
    // One press for everything that failed with it.
    expect(played.textContent).toContain("Doom");
    expect(stats.textContent).toContain("in favourites");
  });

  /**
   * Pressing it destroys it — the failure state is redrawn either way — so a
   * retry that fails again would drop focus to the container. It goes to the
   * new button instead, where the visitor can press it once more.
   */
  it("keeps focus on Try again when the retry fails too", async () => {
    stored("favoriteGames", ["1"]);
    (global as any).fetch = unreachable.offline();
    const { favourites } = mountProfile();

    await window.loadFavoriteGames();

    const retry = favourites.querySelector("button")!;

    retry.focus();
    retry.click();
    await settle();

    const again = favourites.querySelector("button")!;

    expect(again).not.toBe(retry);
    expect(document.activeElement).toBe(again);
  });
});

/**
 * Two removals in quick succession, answered out of order.
 *
 * Each removal re-renders the list and waits on a /games/collection request
 * of its own. When the first one — asked for while the second game was still
 * stored — answered last, it drew the list over the newer one with the
 * removed game back on it, and that game's heart still worked: pressing it
 * added the game straight back (storage went ['3'] → ['3', '2']). Only the
 * newest render of a container may draw.
 */
describe("favorites.js — renders that have been superseded", () => {
  const game = (id: number) => ({ ...DOOM, id, slug: `game-${id}`, title: `Game ${id}` });

  /**
   * /games/collection held open, request by request, so the test can answer
   * them in whatever order it likes.
   */
  function heldCollection() {
    const pending: {
      ids: string[];
      answer: (games: Record<string, unknown>[]) => void;
    }[] = [];

    (global as any).fetch = vi.fn().mockImplementation((url: string) => {
      const ids = decodeURIComponent(url.split("ids=")[1]!).split(",");

      return new Promise((resolve) => {
        pending.push({
          ids,
          answer: (games) => resolve({ ok: true, json: async () => ({ games }) }),
        });
      });
    });

    return pending;
  }

  const storedIds = (key: string) =>
    JSON.parse(localStorage.getItem(key)!).map((entry: { id: string }) => entry.id);

  async function showFavorites(ids: number[], extra = "") {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify(ids.map((id) => ({ id: String(id) }))),
    );
    mockCollection(ids.map(game));
    document.body.innerHTML = `${extra}<div id="favorite-games-container"></div>`;

    await window.loadFavoriteGames();

    return document.getElementById("favorite-games-container")!;
  }

  const heart = (container: HTMLElement, id: number) =>
    container.querySelector<HTMLButtonElement>(`.favorite-btn[data-game-id="${id}"]`)!;

  it("does not draw a removed favourite back from a late answer", async () => {
    const container = await showFavorites([1, 2, 3]);
    const pending = heldCollection();

    heart(container, 1).click();
    heart(container, 2).click();
    await settle();

    expect(pending.map((request) => request.ids)).toEqual([["2", "3"], ["3"]]);

    // The newer answer first, then the older one.
    pending[1]!.answer([game(3)]);
    await settle();
    pending[0]!.answer([game(2), game(3)]);
    await settle();

    expect(heart(container, 2)).toBeNull();
    expect(heart(container, 3)).not.toBeNull();
    expect(storedIds("favoriteGames")).toEqual(["3"]);
  });

  it("still draws a late answer when nothing newer was asked for", async () => {
    const container = await showFavorites([1, 2]);
    const pending = heldCollection();

    heart(container, 1).click();
    await settle();
    pending[0]!.answer([game(2)]);
    await settle();

    expect(heart(container, 1)).toBeNull();
    expect(heart(container, 2)).not.toBeNull();
  });

  /**
   * The stale load also wrote to storage. hydrate() prunes games the server
   * says are gone, and it used to do that by writing back the list it had
   * read before its request — the list from before the newer removal. So
   * whatever the page drew, the removed game was stored again and back on the
   * next visit. Game 4 is deleted server-side here, which is what makes both
   * answers prune.
   */
  it("does not write a removed favourite back into storage from a late answer", async () => {
    const container = await showFavorites([1, 2, 3, 4]);
    const pending = heldCollection();

    heart(container, 1).click();
    heart(container, 2).click();
    await settle();

    pending[1]!.answer([game(3)]);
    await settle();
    pending[0]!.answer([game(2), game(3)]);
    await settle();

    expect(storedIds("favoriteGames")).toEqual(["3"]);
  });

  it("does not count a removed favourite in the stats from a late answer", async () => {
    const container = await showFavorites([1, 2, 3], '<div id="collection-stats"></div>');
    const pending = heldCollection();

    heart(container, 1).click();
    heart(container, 2).click();
    await settle();

    // The list and the stats share each removal's request (see fetchBatch),
    // so there are still only two to answer.
    expect(pending).toHaveLength(2);

    pending[1]!.answer([game(3)]);
    await settle();
    pending[0]!.answer([game(2), game(3)]);
    await settle();

    const tiles = Array.from(document.querySelectorAll("#collection-stats .stat-tile"));
    const favourites = tiles.find((tile) => tile.textContent!.includes("in favourites"));

    expect(favourites!.querySelector(".stat-value")!.textContent).toBe("1");
  });

  it("keeps the recently-played list to the newest answer as well", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([1, 2, 3].map((id) => ({ id: String(id), playedAt: "2026-01-15T10:00:00.000Z" }))),
    );
    mockCollection([1, 2, 3].map(game));
    document.body.innerHTML = '<div id="recently-played-games-container"></div>';

    await window.loadRecentlyPlayedGames();

    const container = document.getElementById("recently-played-games-container")!;
    const remove = (id: number) =>
      container.querySelector<HTMLButtonElement>(`button[data-game-id="${id}"]`);
    const pending = heldCollection();

    remove(1)!.click();
    remove(2)!.click();
    await settle();

    pending[1]!.answer([game(3)]);
    await settle();
    pending[0]!.answer([game(2), game(3)]);
    await settle();

    expect(remove(2)).toBeNull();
    expect(remove(3)).not.toBeNull();
    expect(storedIds("recentlyPlayedGames")).toEqual(["3"]);
  });
});

describe("favorites.js — loadContinuePlaying", () => {
  it("stays hidden when nothing has been played", async () => {
    mockCollection([]);
    document.body.innerHTML = `
      <section id="continue-playing" hidden><div id="continue-playing-list"></div></section>
    `;

    await window.loadContinuePlaying();

    expect(
      (document.getElementById("continue-playing") as HTMLElement).hidden,
    ).toBe(true);
  });

  it("reveals the section and lists played games", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([{ id: "1", playedAt: "2026-01-15T10:00:00.000Z" }]),
    );
    mockCollection([DOOM]);
    document.body.innerHTML = `
      <section id="continue-playing" hidden><div id="continue-playing-list"></div></section>
    `;

    await window.loadContinuePlaying();

    const section = document.getElementById("continue-playing") as HTMLElement;
    expect(section.hidden).toBe(false);
    expect(section.textContent).toContain("Doom");
  });

  it("replaces the placeholders the inline script reserved", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([{ id: "1", playedAt: "2026-01-15T10:00:00.000Z" }]),
    );
    mockCollection([DOOM]);
    document.body.innerHTML = `
      <section id="continue-playing"><div id="continue-playing-list">
        <div class="continue-playing-card is-placeholder" aria-hidden="true"></div>
      </div></section>
    `;

    await window.loadContinuePlaying();

    // A leftover placeholder next to a real card would look like a broken tile.
    expect(document.querySelectorAll(".is-placeholder")).toHaveLength(0);
    expect(document.querySelectorAll(".continue-playing-card")).toHaveLength(1);
  });

  it("clears reserved placeholders when nothing resolves", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([{ id: "404", playedAt: "2026-01-15T10:00:00.000Z" }]),
    );
    mockCollection([]);
    document.body.innerHTML = `
      <section id="continue-playing"><div id="continue-playing-list">
        <div class="continue-playing-card is-placeholder" aria-hidden="true"></div>
      </div></section>
    `;

    await window.loadContinuePlaying();

    const section = document.getElementById("continue-playing") as HTMLElement;
    expect(section.hidden).toBe(true);
    expect(document.querySelectorAll(".is-placeholder")).toHaveLength(0);
  });

  it("staggers the cards so they read as arriving, not blinking on", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify(
        [1, 2].map((id) => ({ id: String(id), playedAt: "2026-01-15T10:00:00.000Z" })),
      ),
    );
    mockCollection([
      { ...DOOM, id: 1 },
      { ...DOOM, id: 2, slug: "quake", title: "Quake" },
    ]);
    document.body.innerHTML = `
      <section id="continue-playing" hidden><div id="continue-playing-list"></div></section>
    `;

    await window.loadContinuePlaying();

    const cards = document.querySelectorAll<HTMLElement>(".continue-playing-card");
    expect(cards[0].style.animationDelay).toBe("0ms");
    expect(cards[1].style.animationDelay).toBe("45ms");
  });

  it("loads the artwork eagerly since it sits above the fold", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([{ id: "1", playedAt: "2026-01-15T10:00:00.000Z" }]),
    );
    mockCollection([DOOM]);
    document.body.innerHTML = `
      <section id="continue-playing" hidden><div id="continue-playing-list"></div></section>
    `;

    await window.loadContinuePlaying();

    expect(
      document.querySelector(".continue-playing-image")!.getAttribute("loading"),
    ).toBe("eager");
  });

  it("shows at most four cards", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify(
        [1, 2, 3, 4, 5, 6].map((id) => ({
          id: String(id),
          playedAt: "2026-01-15T10:00:00.000Z",
        })),
      ),
    );
    mockCollection(
      [1, 2, 3, 4, 5, 6].map((id) => ({
        ...DOOM,
        id,
        slug: `game-${id}`,
        title: `Game ${id}`,
      })),
    );
    document.body.innerHTML = `
      <section id="continue-playing" hidden><div id="continue-playing-list"></div></section>
    `;

    await window.loadContinuePlaying();

    expect(
      document.querySelectorAll(".continue-playing-card").length,
    ).toBe(4);
  });
});

describe("favorites.js — renderCollectionStats", () => {
  it("renders nothing for an empty collection", async () => {
    mockCollection([]);
    document.body.innerHTML = '<div id="collection-stats"></div>';

    await window.renderCollectionStats();

    expect(document.getElementById("collection-stats")!.children.length).toBe(
      0,
    );
  });

  it("counts played games, favourites and genres", async () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([{ id: "1" }, { id: "2" }]),
    );
    localStorage.setItem("favoriteGames", JSON.stringify([{ id: "1" }]));
    mockCollection([
      { ...DOOM, id: 1, genre: "SHOOTER" },
      { ...DOOM, id: 2, slug: "quake", title: "Quake", genre: "SHOOTER" },
    ]);
    document.body.innerHTML = '<div id="collection-stats"></div>';

    await window.renderCollectionStats();

    const text = document.getElementById("collection-stats")!.textContent!;
    expect(text).toContain("games played");
    expect(text).toContain("in favourites");
    expect(text).toContain("Shooter");
  });

  /**
   * The copy of the genre rules the server fixed and this file missed. The
   * favourite-genre tile title-cased the enum by hand, "RPG" came out as
   * "Rpg", and the nudge put "a" in front of whatever it had: "a adventure
   * game", "a action game", "a rpg game".
   */
  async function statsFor(genres: string[]) {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify(genres.map((_, index) => ({ id: String(index + 1) }))),
    );
    mockCollection(
      genres.map((genre, index) => ({
        ...DOOM,
        id: index + 1,
        slug: `game-${index + 1}`,
        genre,
      })),
    );
    document.body.innerHTML = '<div id="collection-stats"></div>';

    await window.renderCollectionStats();

    return document.getElementById("collection-stats")!;
  }

  it("writes RPG in capitals as the favourite genre", async () => {
    const stats = await statsFor(["RPG", "RPG", "SHOOTER"]);
    const tile = Array.from(stats.querySelectorAll(".stat-tile")).find((each) =>
      each.textContent!.includes("favourite genre"),
    )!;

    expect(tile.querySelector(".stat-value")!.textContent).toBe("RPG");
  });

  it("nudges with 'an' where English says 'an'", async () => {
    const stats = await statsFor(["SHOOTER"]);
    const nudge = stats.querySelector(".stat-nudge")!;

    expect(nudge.textContent).toContain("You haven't tried an adventure game yet");
    // Mid-sentence, as views/games/similar-games.ejs writes the same link:
    // "Browse all adventure games".
    expect(nudge.querySelector("a")!.textContent).toBe("browse adventure games");
    expect(nudge.querySelector("a")!.getAttribute("href")).toBe("/adventure");
  });

  it("keeps the initialism whole, article and all", async () => {
    const stats = await statsFor(["ADVENTURE"]);
    const nudge = stats.querySelector(".stat-nudge")!;

    expect(nudge.textContent).toContain("You haven't tried an RPG game yet");
    expect(nudge.querySelector("a")!.textContent).toBe("browse RPG games");
    expect(nudge.querySelector("a")!.getAttribute("href")).toBe("/rpg");
  });

  it("says 'a' before a consonant", async () => {
    const stats = await statsFor(["ADVENTURE", "RPG"]);

    expect(stats.querySelector(".stat-nudge")!.textContent).toContain(
      "You haven't tried a strategy game yet",
    );
  });
});

/**
 * public/js cannot import utils/genre-label.ts — it is a static script, not a
 * module — so favorites.js carries the rules a second time, and a second copy
 * is only safe while something holds it to the first. This does: every value
 * of the GAME_GENRE enum, through both.
 */
describe("favorites.js — the genre rules match utils/genre-label.ts", () => {
  /**
   * GAME_GENRE as the migrations build it, read off disk because the unit
   * project has no database to ask. A statement about the type that this does
   * not recognise fails the test rather than being skipped, so a genre added
   * some other way cannot slip past unchecked.
   */
  function gameGenres(): string[] {
    const dir = path.resolve(__dirname, "../../migrations");
    let genres: string[] = [];

    for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
      const sql = readFileSync(path.join(dir, file), "utf-8");

      for (const statement of sql.split(";")) {
        if (!/\bTYPE\s+"?GAME_GENRE"?/i.test(statement)) continue;

        const created =
          /CREATE\s+TYPE\s+"?GAME_GENRE"?\s+AS\s+ENUM\s*\(([^)]*)\)/i.exec(statement);
        const added =
          /ALTER\s+TYPE\s+"?GAME_GENRE"?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/i.exec(
            statement,
          );
        const renamed =
          /ALTER\s+TYPE\s+"?GAME_GENRE"?\s+RENAME\s+VALUE\s+'([^']+)'\s+TO\s+'([^']+)'/i.exec(
            statement,
          );

        if (created) {
          genres = [...created[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
        } else if (added) {
          genres.push(added[1]!);
        } else if (renamed) {
          genres = genres.map((genre) => (genre === renamed[1] ? renamed[2]! : genre));
        } else {
          throw new Error(
            `${file} changes GAME_GENRE in a way this test cannot read: ${statement.trim()}`,
          );
        }
      }
    }

    return genres;
  }

  const GAME_GENRES = gameGenres();

  it("has the enum to check against", () => {
    expect(GAME_GENRES).toContain("ACTION");
    expect(GAME_GENRES).toContain("RPG");
    expect(GAME_GENRES.length).toBeGreaterThanOrEqual(13);
  });

  it.each(GAME_GENRES)("writes %s as a heading the way the server does", (genre) => {
    expect(window.genreLabel(genre)).toBe(genreLabel(genre));
  });

  it.each(GAME_GENRES)("writes %s mid-sentence the way the server does", (genre) => {
    expect(window.genreInSentence(genre)).toBe(genreInSentence(genre));
  });

  /**
   * The server never needs an article in front of a genre — its sentences put
   * "classic" there — so there is nothing of its to match, and every genre is
   * answered here by hand instead. A genre added to the enum fails the check
   * below until somebody has written down how it is said.
   */
  const ARTICLES: Record<string, string> = {
    ACTION: "an action",
    ADVENTURE: "an adventure",
    // An initialism goes by the name of its first letter: "ar".
    RPG: "an RPG",
    STRATEGY: "a strategy",
    SIMULATION: "a simulation",
    SPORTS: "a sports",
    PUZZLE: "a puzzle",
    // Sounded, so a consonant.
    HORROR: "a horror",
    PLATFORMER: "a platformer",
    RACING: "a racing",
    FIGHTING: "a fighting",
    SHOOTER: "a shooter",
    // Never nudged towards, but the rule answers for it all the same.
    OTHER: "an other",
  };

  it("has an answer written down for every genre in the enum", () => {
    expect(Object.keys(ARTICLES).sort()).toEqual([...GAME_GENRES].sort());
  });

  it.each(Object.entries(ARTICLES))("puts the right article before %s", (genre, said) => {
    expect(window.genreWithArticle(genre)).toBe(said);
  });
});

describe("favorites.js — importCollection", () => {
  it("rejects text that is not JSON", () => {
    const result = window.importCollection("nonsense");
    expect(result.ok).toBe(false);
  });

  it("rejects an export with no games in it", () => {
    const result = window.importCollection(
      JSON.stringify({ version: 2, favorites: [], recentlyPlayed: [] }),
    );
    expect(result.ok).toBe(false);
  });

  it("merges imported favourites with the existing ones", () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "1", addedAt: "2026-01-01T00:00:00.000Z" }]),
    );

    const result = window.importCollection(
      JSON.stringify({
        version: 2,
        favorites: [{ id: "2", addedAt: "2026-02-01T00:00:00.000Z" }],
        recentlyPlayed: [],
      }),
    );

    expect(result.ok).toBe(true);

    const ids = JSON.parse(localStorage.getItem("favoriteGames")!)
      .map((entry: { id: string }) => entry.id)
      .sort();
    expect(ids).toEqual(["1", "2"]);
  });

  it("does not duplicate a game already in the collection", () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "1", addedAt: "2026-01-01T00:00:00.000Z" }]),
    );

    window.importCollection(
      JSON.stringify({
        version: 2,
        favorites: [{ id: "1", addedAt: "2026-03-01T00:00:00.000Z" }],
        recentlyPlayed: [],
      }),
    );

    const list = JSON.parse(localStorage.getItem("favoriteGames")!);
    expect(list).toHaveLength(1);
    expect(list[0].addedAt).toBe("2026-03-01T00:00:00.000Z");
  });

  /**
   * The message used to count the entries in the *file*, so re-importing the
   * same export reported "Imported 40 favourites" having added none at all.
   * What the reader needs is what changed in their collection.
   */
  it("reports how many games were actually added, not how many the file held", () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "1", addedAt: "2026-01-01T00:00:00.000Z" }]),
    );

    const result = window.importCollection(
      JSON.stringify({
        version: 2,
        // "1" is already held; only "2" is new.
        favorites: [
          { id: "1", addedAt: "2026-03-01T00:00:00.000Z" },
          { id: "2", addedAt: "2026-03-01T00:00:00.000Z" },
        ],
        recentlyPlayed: [],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("1 favourite");
    expect(result.message).not.toContain("2 favourites");
  });

  it("says so when the export adds nothing new", () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([{ id: "1", addedAt: "2026-01-01T00:00:00.000Z" }]),
    );

    const result = window.importCollection(
      JSON.stringify({
        version: 2,
        favorites: [{ id: "1", addedAt: "2026-03-01T00:00:00.000Z" }],
        recentlyPlayed: [],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/already in your collection/);
  });

  /**
   * Recently-played is capped at 20. A merge that adds games to a full list
   * displaces others rather than growing it, so counting by length would
   * report nothing added — see countNew.
   */
  it("counts games added to an already-full recently-played list", () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify(
        Array.from({ length: 20 }, (_, index) => ({
          id: String(100 + index),
          playedAt: "2026-01-01T00:00:00.000Z",
        })),
      ),
    );

    const result = window.importCollection(
      JSON.stringify({
        version: 2,
        favorites: [],
        // Newer than everything held, so these win the cap.
        recentlyPlayed: [
          { id: "1", playedAt: "2026-05-01T00:00:00.000Z" },
          { id: "2", playedAt: "2026-05-02T00:00:00.000Z" },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("2 played games");

    const stored = JSON.parse(localStorage.getItem("recentlyPlayedGames")!);
    expect(stored).toHaveLength(20);
  });
});

/**
 * An import the browser would not keep.
 *
 * writeList swallowed a refused write — private browsing, blocked site data,
 * a full quota — and the message was counted from the merged lists the
 * import had *asked* storage to hold. So with storage refusing, the reader
 * was told "Added 2 favourites and 0 played games." in green while the list
 * beneath re-rendered empty. What they are told now is counted from what
 * storage holds afterwards.
 */
describe("favorites.js — importCollection when storage refuses", () => {
  const exported = JSON.stringify({
    version: 2,
    favorites: [
      { id: "1", addedAt: "2026-03-01T00:00:00.000Z" },
      { id: "2", addedAt: "2026-03-02T00:00:00.000Z" },
    ],
    recentlyPlayed: [{ id: "3", playedAt: "2026-03-03T00:00:00.000Z" }],
  });

  /** Storage that throws for these keys, the way a full quota does. */
  function refuse(...keys: string[]) {
    const real = localStorage.setItem;

    return vi
      .spyOn(localStorage, "setItem")
      .mockImplementation((key: string, value: string) => {
        if (keys.includes(key)) {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        }

        real(key, value);
      });
  }

  it("says nothing was saved when every write is refused", () => {
    const setItem = refuse("favoriteGames", "recentlyPlayedGames");

    const result = window.importCollection(exported);

    setItem.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.saved).toBe(false);
    expect(result.message).not.toMatch(/Added/);
    expect(result.message).toMatch(/nothing was imported/i);
    expect(JSON.parse(localStorage.getItem("favoriteGames")!)).toEqual([]);
  });

  it("says which half could not be saved when only one was", () => {
    const setItem = refuse("recentlyPlayedGames");

    const result = window.importCollection(exported);

    setItem.mockRestore();

    expect(result.ok).toBe(false);
    // The favourites did go in, so the page has something to redraw.
    expect(result.saved).toBe(true);
    expect(result.message).toContain("Added 2 favourites");
    expect(result.message).toMatch(/played games couldn't be saved/);
    expect(result.message).not.toContain("1 played game");
  });

  /**
   * An export with no played games still writes that list back, unchanged,
   * and on storage that has room for nothing that second write can succeed
   * where the first one failed. Only the favourites were asked for, so
   * "every game was already there" — which is what zero added and one write
   * accepted used to add up to — would be the wrong thing to say.
   */
  it("does not call a refused import 'already in your collection'", () => {
    const setItem = refuse("favoriteGames");

    const result = window.importCollection(
      JSON.stringify({ version: 2, favorites: [{ id: "9" }], recentlyPlayed: [] }),
    );

    setItem.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.message).not.toMatch(/already in your collection/);
  });

  it("still reports a normal import as saved", () => {
    const result = window.importCollection(exported);

    expect(result).toMatchObject({ ok: true, saved: true });
    expect(result.message).toBe("Added 2 favourites and 1 played game.");
  });

  // The page reads the result, not only the function: the status line turns
  // red, and the lists are redrawn only if something was stored.
  it("shows the refusal as an error on the profile page", async () => {
    mockCollection([]);
    document.body.innerHTML = `
      <div id="favorite-games-container"><p>untouched</p></div>
      <input id="import-collection" type="file" />
      <p id="collection-transfer-status"></p>
    `;
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await settle();

    const container = document.getElementById("favorite-games-container")!;

    container.innerHTML = "<p>untouched</p>";

    const input = document.getElementById("import-collection") as HTMLInputElement;

    Object.defineProperty(input, "files", {
      configurable: true,
      value: [{ text: async () => exported }],
    });

    const setItem = refuse("favoriteGames", "recentlyPlayedGames");

    input.dispatchEvent(new Event("change"));
    await settle();

    setItem.mockRestore();

    const status = document.getElementById("collection-transfer-status")!;

    expect(status.className).toContain("is-error");
    expect(status.textContent).toMatch(/nothing was imported/i);
    // Nothing changed, so nothing was redrawn.
    expect(container.textContent).toBe("untouched");
  });
});

/**
 * The heart is a toggle, and it never said so.
 *
 * aria-pressed was not set at all, so a screen reader announced an ordinary
 * button; and the aria-label the template renders ("Add Doom to favorites")
 * stayed on it after it had been pressed, which is the opposite of what the
 * page then showed. data-title is how the script learns the game's name —
 * views/games/game-item.ejs, views/lists/most-played.ejs and the game page
 * all render it, and favorites.js puts it on the buttons it builds itself.
 */
describe("favorites.js — the heart reports its own state", () => {
  function serverRenderedButton(title = "Doom") {
    document.body.innerHTML = `
      <button class="favorite-btn" type="button"
              aria-pressed="false"
              aria-label="Add ${title} to favorites"
              data-game-id="42" data-title="${title}"></button>
    `;

    return document.querySelector(".favorite-btn") as HTMLButtonElement;
  }

  it("says pressed, and offers to remove, once the game is a favourite", () => {
    const btn = serverRenderedButton();

    window.updateFavoriteButton(btn, true);

    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Remove Doom from favorites");
  });

  it("goes back to unpressed, and offers to add", () => {
    const btn = serverRenderedButton();

    window.updateFavoriteButton(btn, true);
    window.updateFavoriteButton(btn, false);

    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("aria-label")).toBe("Add Doom to favorites");
  });

  it("follows a real toggle, label and all", () => {
    const btn = serverRenderedButton("Prince of Persia");

    window.toggleFavorite(btn);

    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe(
      "Remove Prince of Persia from favorites",
    );

    window.toggleFavorite(btn);

    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("aria-label")).toBe(
      "Add Prince of Persia to favorites",
    );
  });

  // Naming no game beats naming the wrong one: a button rendered without
  // data-title still gets a correct, if unqualified, label.
  it("falls back to the unqualified wording without a title", () => {
    const btn = makeBtn({ gameId: "7" });

    btn.className = "favorite-btn";
    window.updateFavoriteButton(btn, true);

    expect(btn.getAttribute("aria-label")).toBe("Remove from favorites");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the visual state it always had", () => {
    const btn = serverRenderedButton();

    window.updateFavoriteButton(btn, true);
    expect(btn.classList.contains("liked")).toBe(true);

    window.updateFavoriteButton(btn, false);
    expect(btn.classList.contains("liked")).toBe(false);
  });
});

/**
 * The import control, which a keyboard could reach and nobody could see.
 *
 * Its file input is clipped with .visually-hidden so that it stays in the tab
 * order (views/profile.ejs explains why it is not `hidden`), and nothing drew
 * focus on it or on the label beside it: Tab landed on an invisible control
 * and the page did not change. The label is the visible half, so it takes the
 * ring — for the input's focus only, not for the Export button's.
 */
describe("profile.ejs and style.css — the import control shows its focus", () => {
  const root = path.resolve(__dirname, "../..");
  const profile = readFileSync(path.join(root, "views/profile.ejs"), "utf-8");
  // Comments out first, or the text before a rule reads as part of its
  // selector.
  const stylesheet = readFileSync(
    path.join(root, "public/css/style.css"),
    "utf-8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  /** The rule that rings the label: its selector, and its declarations. */
  const rule =
    /([^{}]*\.collection-transfer[^{}]*:focus-visible[^{}]*)\{([^}]*)\}/.exec(
      stylesheet,
    );
  const selector = () => rule![1]!.trim();

  /** The row exactly as views/profile.ejs writes it, EJS tags taken out. */
  function mountRow() {
    const row = new DOMParser()
      .parseFromString(profile.replace(/<%[\s\S]*?%>/g, ""), "text/html")
      .querySelector(".collection-transfer");

    expect(row, "no .collection-transfer in views/profile.ejs").not.toBeNull();
    document.body.innerHTML = row!.outerHTML;

    return {
      exportButton: document.getElementById("export-collection") as HTMLElement,
      input: document.getElementById("import-collection") as HTMLInputElement,
      label: document.querySelector('label[for="import-collection"]') as HTMLElement,
    };
  }

  /**
   * Focus moved the way a Tab press moves it. :focus-visible is decided by
   * how focus arrived, and jsdom's selector engine follows the keyboard the
   * same way a browser does, so a bare focus() on a file input would not
   * match it at all.
   */
  function tabTo(from: Element, to: HTMLElement) {
    from.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    to.focus();
  }

  it("draws the site's focus ring", () => {
    expect(rule, "no :focus-visible rule for .collection-transfer").not.toBeNull();
    expect(rule![2]).toMatch(/outline:\s*2px solid var\(--nc-title\)/);
  });

  it("rings the label while the clipped input has keyboard focus", () => {
    const { input, label } = mountRow();

    // Still reachable: clipped, not hidden.
    expect(input.hidden).toBe(false);
    expect(input.classList.contains("visually-hidden")).toBe(true);

    tabTo(document.body, input);

    expect(document.activeElement).toBe(input);
    expect(label.matches(selector())).toBe(true);
  });

  // :focus-within on the row, the obvious rule, would ring the Import label
  // while the keyboard was on Export — a second ring, on the wrong control.
  it("leaves the label alone while focus is on the Export button", () => {
    const { exportButton, label } = mountRow();

    tabTo(document.body, exportButton);

    expect(document.activeElement).toBe(exportButton);
    expect(label.matches(selector())).toBe(false);
  });
});
