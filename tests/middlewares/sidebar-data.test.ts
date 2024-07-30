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
    getSitemapCounts: vi.fn(),
    count: vi.fn(),
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
const { ALL_LIST_SLUGS, LISTS } = await import("../../routes/lists.ts");

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
    // A catalogue with gaps in it: two genres of the enum's thirteen, three
    // of the twenty-seven A–Z pages, two years.
    vi.mocked(Game.getSitemapCounts).mockResolvedValue({
      counts: new Map([
        ["genre:ACTION", 3],
        ["genre:RPG", 1],
        ["letter:d", 2],
        ["letter:z", 1],
        ["letter:0-9", 1],
        ["year:1993", 3],
        ["year:1990", 1],
        ["developer:id Software", 2],
        ["publisher:GT Interactive", 2],
      ]),
      lastmods: new Map(),
    });
    vi.mocked(Game.count).mockResolvedValue(4);
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

  /**
   * A failure is remembered, but only for a few seconds.
   *
   * With Postgres away every entry rejects on every request, and nothing
   * used to remember that the last request had just found the same thing —
   * so one page view cost six doomed queries and the next one six more,
   * each after waiting out the pool's connection timeout. The widget still
   * renders blank either way; what the short window changes is how often
   * the outage is paid for. See FAILURE_TTL_MS.
   */
  it("remembers a failed list briefly rather than re-asking per request", async () => {
    vi.useFakeTimers();

    try {
      vi.mocked(Game.getGenres).mockRejectedValueOnce(new Error("db down"));

      const first = await run({ path: "/", method: "GET" });
      expect(first.res.locals.gameGenres).toEqual([]);

      const second = await run({ path: "/", method: "GET" });
      expect(second.res.locals.gameGenres).toEqual([]);
      expect(Game.getGenres).toHaveBeenCalledTimes(1);

      // ...and asks again once the window has run out, so a database that
      // has come back is noticed almost at once.
      await vi.advanceTimersByTimeAsync(5_000);

      const third = await run({ path: "/", method: "GET" });
      expect(third.res.locals.gameGenres).toEqual(["ACTION"]);
      expect(Game.getGenres).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The pick must not outlive its own week. A flat hour meant one fetched
   * five minutes before the week turned was still on the page fifty-five
   * minutes later — and getOrSelectCurrent, which chooses the next one, was
   * never asked, because the entry was still warm.
   */
  it("holds the game of the week no longer than its endDate", async () => {
    vi.useFakeTimers();

    try {
      vi.mocked(GameOfTheWeek.getOrSelectCurrent).mockResolvedValue({
        id: 5,
        endDate: new Date(Date.now() + 60_000),
      } as any);

      await run({ path: "/", method: "GET" });
      expect(GameOfTheWeek.getOrSelectCurrent).toHaveBeenCalledTimes(1);

      // Well inside the nominal hour, but past the pick's own endDate.
      await vi.advanceTimersByTimeAsync(90_000);

      await run({ path: "/", method: "GET" });
      expect(GameOfTheWeek.getOrSelectCurrent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Which listing pages exist, for the chrome that links to them.
   *
   * The sidebar's genre list, the error pages' genre row, the A–Z filter and
   * the footer all linked every value they knew — every GAME_GENRE in the
   * enum, all twenty-six letters — while each of those pages answers 404 when
   * the catalogue holds nothing for it. They read these locals now, and every
   * one of them comes off the single GROUP BY that already decided which
   * curated lists to link: Game.getSitemapCounts, cached with the rest of the
   * chrome rather than asked again per page.
   */
  describe("which listings the chrome may link to", () => {
    it("names the genres a game is filed under, and no others", async () => {
      const { res } = await run({ path: "/", method: "GET" });

      expect(res.locals.nonEmptyGenres).toEqual(new Set(["ACTION", "RPG"]));
    });

    it("names the release years with a game in them", async () => {
      const { res } = await run({ path: "/", method: "GET" });

      expect(res.locals.nonEmptyYears).toEqual(new Set([1993, 1990]));
    });

    // All twenty-seven, so the filter's row keeps its shape; only the ones
    // with a page behind them are links.
    it("marks every page of the alphabet filter, and which have games", async () => {
      const { res } = await run({ path: "/", method: "GET" });
      const buckets = res.locals.letterBuckets as {
        bucket: string;
        label: string;
        linked: boolean;
      }[];

      expect(buckets).toHaveLength(27);
      expect(buckets[0]).toEqual({ bucket: "0-9", label: "0–9", linked: true });
      expect(
        buckets.filter((entry) => entry.linked).map((entry) => entry.bucket),
      ).toEqual(["0-9", "d", "z"]);
      expect(buckets.find((entry) => entry.bucket === "q")).toEqual({
        bucket: "q",
        label: "Q",
        linked: false,
      });
    });

    it("names the curated lists by the same counts", async () => {
      const { res } = await run({ path: "/", method: "GET" });
      const slugs = res.locals.nonEmptyListSlugs as Set<string>;

      expect(slugs.has("best-action-games")).toBe(true);
      expect(slugs.has("best-rpg-games")).toBe(true);
      expect(slugs.has("dos-games-1990s")).toBe(true);
      expect(slugs.has("top-dos-games")).toBe(true);
      expect(slugs.has("best-horror-games")).toBe(false);
      expect(slugs.has("dos-games-1980s")).toBe(false);
    });

    // For the "Popular" blocks on /developers and /publishers, which rank by
    // these rather than running a GROUP BY of their own per request.
    it("hands on the counts themselves", async () => {
      const { res } = await run({ path: "/developers", method: "GET" });
      const counts = res.locals.listingCounts as Map<string, number>;

      expect(counts.get("developer:id Software")).toBe(2);
      expect(counts.get("publisher:GT Interactive")).toBe(2);
    });

    it("asks for all of it once, for every page that follows", async () => {
      await run({ path: "/", method: "GET" });
      await run({ path: "/action", method: "GET" });
      await run({ path: "/letter/d", method: "GET" });

      expect(Game.getSitemapCounts).toHaveBeenCalledTimes(1);
      expect(Game.count).toHaveBeenCalledTimes(1);
    });

    /**
     * A failed count is not a reason to decide the catalogue is empty and
     * take every genre, letter and year off every page. Unknown means "link
     * everything", which is what the chrome did before it knew — each page
     * behind a link still answers 404 for itself if it has to.
     */
    it("links everything when the counts cannot be had", async () => {
      vi.mocked(Game.getSitemapCounts).mockRejectedValue(new Error("db down"));

      const { res, next } = await run({ path: "/", method: "GET" });

      expect(res.locals.nonEmptyListSlugs).toBe(ALL_LIST_SLUGS);
      expect((res.locals.nonEmptyListSlugs as Set<string>).size).toBe(
        LISTS.length,
      );
      expect(res.locals.nonEmptyGenres).toBeNull();
      expect(res.locals.nonEmptyYears).toBeNull();
      expect(res.locals.listingCounts).toBeNull();
      expect(res.locals.letterBuckets).toHaveLength(27);
      expect(
        (res.locals.letterBuckets as { linked: boolean }[]).every(
          (entry) => entry.linked,
        ),
      ).toBe(true);
      expect(next).toHaveBeenCalled();
    });
  });

  // Every outcome of an admin form post but one is a redirect, and the one
  // that renders loads the chrome itself — see loadSidebarData.
  it("skips the chrome for the admin form posts", async () => {
    for (const path of ["/games", "/games/12", "/games/12/delete", "/news"]) {
      expect(needsSidebarData({ path, method: "POST" } as Request)).toBe(false);
      expect(needsSidebarData({ path, method: "GET" } as Request)).toBe(true);
    }

    // The login form re-renders on a failure without any of this, so POST is
    // not by itself the rule.
    expect(
      needsSidebarData({ path: "/login", method: "POST" } as Request),
    ).toBe(true);
  });
});
