import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../../models/game", () => ({
  default: {
    getGenres: vi.fn(),
    findRecentlyAdded: vi.fn(),
    findTopRated: vi.fn(),
    findMostPlayed: vi.fn(),
    getPublishers: vi.fn(),
    getDevelopers: vi.fn(),
  },
}));

vi.mock("../../models/comment", () => ({
  default: { findRecent: vi.fn() },
}));

vi.mock("../../models/game-of-the-week", () => ({
  default: { getOrSelectCurrent: vi.fn() },
}));

const Game = (await import("../../models/game.ts")).default;
const Comment = (await import("../../models/comment.ts")).default;
const GameOfTheWeek = (await import("../../models/game-of-the-week.ts"))
  .default;
const { cache, needsSidebarData, sidebarData } =
  await import("../../middlewares/sidebar-data.ts");

function run(req: Partial<Request>) {
  const res = { locals: {} } as Response;
  const next = vi.fn() as unknown as NextFunction;

  return sidebarData(req as Request, res, next).then(() => ({ res, next }));
}

describe("needsSidebarData", () => {
  it("skips the feeds, the sitemap and the JSON endpoints", () => {
    for (const path of [
      "/sitemap-index.xml",
      "/sitemap-1.xml",
      "/sitemap-12.xml",
      "/feed.xml",
      "/news/feed.xml",
      "/games/collection",
      "/games/my-ratings",
    ]) {
      expect(needsSidebarData({ path, method: "GET" } as Request)).toBe(false);
    }
  });

  it("skips the comment endpoints that render no page", () => {
    // POST /comments answers with the single comment just created.
    expect(
      needsSidebarData({ path: "/comments", method: "POST" } as Request),
    ).toBe(false);
    // /comments/:gameId answers with a JSON batch.
    expect(
      needsSidebarData({ path: "/comments/12", method: "GET" } as Request),
    ).toBe(false);
  });

  it("loads for the site-wide comment overview and for ordinary pages", () => {
    expect(
      needsSidebarData({ path: "/comments", method: "GET" } as Request),
    ).toBe(true);

    for (const path of ["/", "/action", "/doom", "/news", "/game-lists"]) {
      expect(needsSidebarData({ path, method: "GET" } as Request)).toBe(true);
    }
  });
});

describe("sidebarData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cache.clear();

    vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
    vi.mocked(Game.findRecentlyAdded).mockResolvedValue([{ id: 1 }] as any);
    vi.mocked(Game.findTopRated).mockResolvedValue([{ id: 2 }] as any);
    vi.mocked(Game.findMostPlayed).mockResolvedValue([{ id: 3 }] as any);
    vi.mocked(Comment.findRecent).mockResolvedValue([{ id: 4 }] as any);
    vi.mocked(GameOfTheWeek.getOrSelectCurrent).mockResolvedValue({
      id: 5,
    } as any);
    vi.mocked(Game.getPublishers).mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => `Publisher ${i}`),
    );
    vi.mocked(Game.getDevelopers).mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => `Developer ${i}`),
    );
  });

  it("puts every list the chrome needs on res.locals", async () => {
    const { res, next } = await run({ path: "/", method: "GET" });

    expect(res.locals.gameGenres).toEqual(["ACTION"]);
    expect(res.locals.recentlyAddedGames).toEqual([{ id: 1 }]);
    expect(res.locals.topRatedGames).toEqual([{ id: 2 }]);
    expect(res.locals.mostPlayedGames).toEqual([{ id: 3 }]);
    expect(res.locals.latestComments).toEqual([{ id: 4 }]);
    expect(res.locals.gameOfTheWeek).toEqual({ id: 5 });
    expect(next).toHaveBeenCalled();
  });

  // popularPublishers and popularDevelopers used to be loaded here too — two
  // SELECT DISTINCT scans over "games" on every cold cache — for locals no
  // view has ever read. They are not loaded any more.
  it("loads nothing no view reads", async () => {
    const { res } = await run({ path: "/", method: "GET" });

    expect(res.locals.popularPublishers).toBeUndefined();
    expect(res.locals.popularDevelopers).toBeUndefined();
    expect(Game.getPublishers).not.toHaveBeenCalled();
    expect(Game.getDevelopers).not.toHaveBeenCalled();
  });

  it("queries nothing for a request that renders no chrome", async () => {
    const { res, next } = await run({ path: "/feed.xml", method: "GET" });

    expect(Game.getGenres).not.toHaveBeenCalled();
    expect(GameOfTheWeek.getOrSelectCurrent).not.toHaveBeenCalled();
    expect(res.locals.gameGenres).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it("serves a second request from the cache", async () => {
    await run({ path: "/", method: "GET" });
    await run({ path: "/action", method: "GET" });

    expect(Game.getGenres).toHaveBeenCalledTimes(1);
    expect(Comment.findRecent).toHaveBeenCalledTimes(1);
  });

  // These used to sit in one try/catch per block, so a single failing query
  // blanked the four lists that happened to follow it.
  it("blanks only the list that failed and still renders the page", async () => {
    vi.mocked(Game.findTopRated).mockRejectedValue(new Error("db down"));

    const { res, next } = await run({ path: "/", method: "GET" });

    expect(res.locals.topRatedGames).toEqual([]);
    expect(res.locals.mostPlayedGames).toEqual([{ id: 3 }]);
    expect(res.locals.latestComments).toEqual([{ id: 4 }]);
    expect(res.locals.gameOfTheWeek).toEqual({ id: 5 });
    expect(next).toHaveBeenCalled();
  });

  it("falls back to null for a missing game of the week", async () => {
    vi.mocked(GameOfTheWeek.getOrSelectCurrent).mockRejectedValue(
      new Error("db down"),
    );

    const { res } = await run({ path: "/", method: "GET" });

    expect(res.locals.gameOfTheWeek).toBeNull();
  });

  it("retries a failed list on the next request rather than caching the error", async () => {
    vi.mocked(Game.getGenres).mockRejectedValueOnce(new Error("db down"));

    const first = await run({ path: "/", method: "GET" });
    expect(first.res.locals.gameGenres).toEqual([]);

    const second = await run({ path: "/", method: "GET" });
    expect(second.res.locals.gameGenres).toEqual(["ACTION"]);
  });
});
