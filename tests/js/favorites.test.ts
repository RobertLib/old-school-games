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
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeBtn(overrides: Record<string, string> = {}): HTMLButtonElement {
  const btn = document.createElement("button") as HTMLButtonElement;
  const defaults: Record<string, string> = {
    gameId: "1",
    gameTitle: "Test Game",
    gameSlug: "test-game",
    gameImage: "img.png",
    gameDescription: "A great DOS game",
  };
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
    addToRecentlyPlayed: (game: Record<string, string>) => void;
    removeFromRecentlyPlayed: (id: string) => void;
    loadFavoriteGames: () => void;
    loadRecentlyPlayedGames: () => void;
    addGameToRecentlyPlayed: (
      id: string,
      title: string,
      slug: string,
      image: string,
      desc: string,
    ) => void;
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
  const baseGame = {
    id: "10",
    title: "DOS Game",
    slug: "dos-game",
    image: "img.png",
    description: "Classic",
  };

  it("adds game to recently played with a playedAt timestamp", () => {
    window.addToRecentlyPlayed(baseGame);
    const list = JSON.parse(localStorage.getItem("recentlyPlayedGames")!);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("10");
    expect(list[0].playedAt).toBeDefined();
  });

  it("deduplicates — moves existing entry to front", () => {
    window.addToRecentlyPlayed({ ...baseGame, id: "10" });
    window.addToRecentlyPlayed({ ...baseGame, id: "20", title: "Other" });
    window.addToRecentlyPlayed({ ...baseGame, id: "10" });

    const list = JSON.parse(localStorage.getItem("recentlyPlayedGames")!);
    const ids = list.map((g: { id: string }) => g.id);
    expect(ids.filter((id: string) => id === "10").length).toBe(1);
    expect(ids[0]).toBe("10");
  });

  it("limits the recently played list to 10 entries", () => {
    for (let i = 0; i < 15; i++) {
      window.addToRecentlyPlayed({
        id: `${i}`,
        title: `Game ${i}`,
        slug: `game-${i}`,
        image: "",
        description: "",
      });
    }
    const list = JSON.parse(localStorage.getItem("recentlyPlayedGames")!);
    expect(list.length).toBe(10);
  });

  it("removes a game from recently played by id", () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([{ id: "10", title: "DOS Game" }]),
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

describe("favorites.js — window.addGameToRecentlyPlayed (public API)", () => {
  it("delegates to addToRecentlyPlayed and stores entry", () => {
    window.addGameToRecentlyPlayed(
      "42",
      "My Game",
      "my-game",
      "img.jpg",
      "Desc",
    );
    const list = JSON.parse(localStorage.getItem("recentlyPlayedGames")!);
    expect(list.some((g: { id: string }) => g.id === "42")).toBe(true);
  });
});

describe("favorites.js — loadFavoriteGames", () => {
  it("renders empty-state message when no favorites", () => {
    document.body.innerHTML = '<div id="favorite-games-container"></div>';
    window.loadFavoriteGames();
    const html = document.getElementById("favorite-games-container")!.innerHTML;
    expect(html).toContain("don't have any favorite games");
  });

  it("renders game items when favorites exist", () => {
    localStorage.setItem(
      "favoriteGames",
      JSON.stringify([
        {
          id: "1",
          title: "Doom",
          slug: "doom",
          image: "doom.jpg",
          description: "Legendary FPS",
        },
      ]),
    );
    document.body.innerHTML = '<div id="favorite-games-container"></div>';
    window.loadFavoriteGames();
    const html = document.getElementById("favorite-games-container")!.innerHTML;
    expect(html).toContain("Doom");
    expect(html).toContain("/doom");
  });

  it("does not throw when container element is absent", () => {
    expect(() => window.loadFavoriteGames()).not.toThrow();
  });
});

describe("favorites.js — loadRecentlyPlayedGames", () => {
  it("renders empty-state message when no recently played games", () => {
    document.body.innerHTML =
      '<div id="recently-played-games-container"></div>';
    window.loadRecentlyPlayedGames();
    const html = document.getElementById(
      "recently-played-games-container",
    )!.innerHTML;
    expect(html).toContain("haven't played any games");
  });

  it("renders game items when recently played games exist", () => {
    localStorage.setItem(
      "recentlyPlayedGames",
      JSON.stringify([
        {
          id: "1",
          title: "Quake",
          slug: "quake",
          image: "quake.jpg",
          description: "3D FPS",
          playedAt: new Date().toISOString(),
        },
      ]),
    );
    document.body.innerHTML =
      '<div id="recently-played-games-container"></div>';
    window.loadRecentlyPlayedGames();
    const html = document.getElementById(
      "recently-played-games-container",
    )!.innerHTML;
    expect(html).toContain("Quake");
    expect(html).toContain("/quake");
  });

  it("does not throw when container element is absent", () => {
    expect(() => window.loadRecentlyPlayedGames()).not.toThrow();
  });
});
