/**
 * @vitest-environment jsdom
 */
import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

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
    importCollection: (text: string) => { ok: boolean; message: string };
    invalidateCollectionCache: () => void;
    addGameToRecentlyPlayed: (id: string) => void;
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

  it("does not throw when container element is absent", async () => {
    mockCollection([]);
    await expect(window.loadRecentlyPlayedGames()).resolves.toBeUndefined();
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
