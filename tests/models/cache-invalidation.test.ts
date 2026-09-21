import { beforeEach, describe, expect, it, vi } from "vitest";
import Game from "../../models/game.ts";
import News from "../../models/news.ts";
import Comment from "../../models/comment.ts";
import db from "../../db.ts";
// From utils, which is where these live now: reaching into the routers for
// them closed a models -> routes -> models import cycle. Mocking one module
// rather than three also means this no longer stubs out three whole routers
// to observe three functions — see utils/page-cache.ts.
import {
  clearFeedCache,
  clearMostPlayedCache,
  clearSitemapCache,
} from "../../utils/page-cache.ts";
import {
  FEATURED_POOL_KEY,
  GAME_OF_THE_WEEK_KEY,
  LATEST_COMMENTS_KEY,
  MOST_PLAYED_GAMES_KEY,
  RECENTLY_ADDED_KEY,
  TOP_RATED_GAMES_KEY,
  sidebarCache,
} from "../../utils/sidebar-cache.ts";
import { bumpCacheEpoch } from "../../utils/cache-epoch.ts";

vi.mock("../../db", () => ({
  default: { query: vi.fn() },
}));

vi.mock("../../utils/page-cache", () => ({
  clearSitemapCache: vi.fn(),
  clearFeedCache: vi.fn(),
  clearMostPlayedCache: vi.fn(),
}));

vi.mock("../../utils/cache-epoch", () => ({
  bumpCacheEpoch: vi.fn(async () => {}),
}));

const mockDb = vi.mocked(db);

/**
 * The sitemap is cached for a day and each RSS feed for fifteen minutes, so a
 * write has to drop both. clearFeedCache existed but nothing outside the tests
 * ever called it: a game or article added here showed up in the sitemap at once
 * and stayed missing from the feed until its TTL happened to expire.
 */
describe("write-through cache invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // resolveSlug reads the slug history, then the write returns the new row.
    // "rowCount" is what Game.delete and News.delete report back, and it is
    // now also what decides whether they invalidate anything at all — a
    // delete that matched nothing changed nothing. Without it here every
    // delete below would read as a no-op.
    mockDb.query.mockResolvedValue({
      rows: [{ id: 1, slug: "doom" }],
      rowCount: 1,
    } as any);
  });

  function expectBothCachesDropped() {
    expect(clearSitemapCache).toHaveBeenCalled();
    expect(clearFeedCache).toHaveBeenCalled();
  }

  /**
   * Every cached widget a game write also has to drop, and the page built from
   * one of them. A deleted game went on being offered by all of them after it
   * stopped existing, so each of those links answered a 404 — while the same
   * save had already dropped the sitemap and the feed.
   *
   * Game of the week is in here because it was the one that got left behind
   * when the rankings were fixed, and it is held the longest of the lot: an
   * hour, against five minutes for the rankings. See GAME_OF_THE_WEEK_KEY.
   */
  describe("the cached widgets a game write invalidates", () => {
    const WIDGET_KEYS = [
      FEATURED_POOL_KEY,
      RECENTLY_ADDED_KEY,
      MOST_PLAYED_GAMES_KEY,
      TOP_RATED_GAMES_KEY,
      GAME_OF_THE_WEEK_KEY,
    ];

    beforeEach(() => {
      sidebarCache.clear();

      // A held entry per key, so dropping one is observable.
      for (const key of WIDGET_KEYS) {
        void sidebarCache.get(key, 60_000, async () => []);
      }
    });

    it.each([
      ["created", () => Game.create({ title: "Doom", genre: "ACTION" })],
      ["updated", () => Game.update(1, { title: "Doom", genre: "ACTION" })],
      ["deleted", () => Game.delete(1)],
    ])("drops every cached widget when a game is %s", async (_label, write) => {
      for (const key of WIDGET_KEYS) {
        expect(sidebarCache.has(key)).toBe(true);
      }

      await write();

      for (const key of WIDGET_KEYS) {
        expect(sidebarCache.has(key)).toBe(false);
      }

      expect(clearMostPlayedCache).toHaveBeenCalled();
    });

    /**
     * An article touches none of them, so it should leave every one alone
     * rather than making every page reload them.
     */
    it("leaves them alone when an article is written", async () => {
      await News.create({ title: "Hello", content: "Body", userId: 1 });

      for (const key of WIDGET_KEYS) {
        expect(sidebarCache.has(key)).toBe(true);
      }

      expect(clearMostPlayedCache).not.toHaveBeenCalled();
    });
  });

  it("drops both caches when a game is created", async () => {
    await Game.create({ title: "Doom", genre: "ACTION" });

    expectBothCachesDropped();
  });

  it("drops both caches when a game is updated", async () => {
    await Game.update(1, { title: "Doom", genre: "ACTION" });

    expectBothCachesDropped();
  });

  it("drops both caches when a game is deleted", async () => {
    await Game.delete(1);

    expectBothCachesDropped();
  });

  /**
   * A delete that matched no row changed nothing, so it must invalidate
   * nothing. This used to clear regardless of the outcome, which threw away
   * the sitemap, both feeds and five widgets on behalf of an admin
   * double-clicking a stale button or a crawler replaying an old form post —
   * and the sitemap is the better part of the catalogue to rebuild.
   *
   * The route already distinguishes the two cases: Game.delete reports
   * whether a row went, and a false answer is flashed as "Game not found."
   */
  it("drops nothing when a game delete matched no row", async () => {
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 } as any);

    await expect(Game.delete(1)).resolves.toBe(false);

    expect(clearSitemapCache).not.toHaveBeenCalled();
    expect(clearFeedCache).not.toHaveBeenCalled();
    expect(clearMostPlayedCache).not.toHaveBeenCalled();
  });

  it("drops both caches when an article is created", async () => {
    await News.create({ title: "Hello", content: "Body", userId: 1 });

    expectBothCachesDropped();
  });

  it("drops both caches when an article is updated", async () => {
    await News.update(1, { title: "Hello", content: "Body" });

    expectBothCachesDropped();
  });

  it("drops both caches when an article is deleted", async () => {
    await News.delete(1);

    expectBothCachesDropped();
  });

  /**
   * The mirror of the game case above, which is the one that had the guard.
   * News.delete cleared whatever its UPDATE matched, so a second delete of the
   * same article — or one of an id that was never there — threw away the
   * sitemap and both feeds for nothing. The route already tells the two apart:
   * a false answer is flashed as "News not found."
   */
  it("drops nothing when an article delete matched no row", async () => {
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 } as any);

    await expect(News.delete(1)).resolves.toBe(false);

    expect(clearSitemapCache).not.toHaveBeenCalled();
    expect(clearFeedCache).not.toHaveBeenCalled();
  });

  /**
   * Which scope a write tells the other machines about — see
   * utils/cache-epoch.ts. There used to be one counter for the whole app, so
   * the effect on a remote machine was the same whatever had been written: a
   * posted comment, which is the most frequent write on the site and drops
   * exactly one sidebar entry locally, made every other machine throw away
   * everything it held — the sitemap included, which is cached for a day.
   *
   * The invariant is that a remote machine drops exactly what the writing
   * machine dropped locally, so these assertions are the other half of the
   * local ones above.
   */
  describe("what the other machines are told", () => {
    it.each([
      ["a comment is created", () =>
        Comment.create({ nick: "a", content: "b", gameId: 1 })],
      ["a comment is deleted", () => Comment.delete(1)],
    ])("bumps only the comments scope when %s", async (_label, write) => {
      await write();

      expect(bumpCacheEpoch).toHaveBeenCalledWith("comments");
      expect(bumpCacheEpoch).toHaveBeenCalledTimes(1);
    });

    // A game or news write legitimately invalidates almost everything, so it
    // keeps the broad scope — which bumpCacheEpoch takes by default.
    it.each([
      ["a game is created", () => Game.create({ title: "Doom", genre: "ACTION" })],
      ["a game is deleted", () => Game.delete(1)],
      ["an article is created", () =>
        News.create({ title: "Hello", content: "Body", userId: 1 })],
      ["an article is deleted", () => News.delete(1)],
    ])("bumps the broad scope when %s", async (_label, write) => {
      await write();

      expect(bumpCacheEpoch).toHaveBeenCalledWith();
    });

    // And the local half of the comment case, which is what the remote effect
    // has to mirror: one entry, not the lot.
    it("drops only the comments widget locally", async () => {
      sidebarCache.clear();

      for (const key of [LATEST_COMMENTS_KEY, RECENTLY_ADDED_KEY]) {
        void sidebarCache.get(key, 60_000, async () => []);
      }

      await Comment.create({ nick: "a", content: "b", gameId: 1 });

      expect(sidebarCache.has(LATEST_COMMENTS_KEY)).toBe(false);
      expect(sidebarCache.has(RECENTLY_ADDED_KEY)).toBe(true);
      expect(clearSitemapCache).not.toHaveBeenCalled();
    });
  });
});
