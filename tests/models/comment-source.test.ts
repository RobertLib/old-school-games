import { beforeEach, describe, expect, it, vi } from "vitest";
import pool from "../../db.ts";
import Comment, {
  SOURCE_RETENTION_DAYS,
  commentSource,
} from "../../models/comment.ts";
import {
  LATEST_COMMENTS_KEY,
  MOST_DISCUSSED_KEY,
  sidebarCache,
} from "../../utils/sidebar-cache.ts";
import { bumpCacheEpoch } from "../../utils/cache-epoch.ts";

// Observed rather than run: the bump is fire-and-forget, so the only way to
// assert it happened is to be the function it calls. The same arrangement as
// tests/models/cache-invalidation.test.ts.
vi.mock("../../utils/cache-epoch", () => ({
  bumpCacheEpoch: vi.fn(async () => {}),
}));

/**
 * A comment's source, against a real database: what is stored, what groups,
 * what a moderator's "delete all from this source" takes with it, and the
 * retention the privacy policy promises.
 *
 * The mocked suite in comment.test.ts can say which SQL was sent; the
 * grouping, the cascade and the CHECK only exist in Postgres.
 */
describe("comment sources", () => {
  const FLOODER = "203.0.113.7";
  const NEIGHBOUR = "198.51.100.23";

  let gameId: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    sidebarCache.clear();

    await pool.query('TRUNCATE "comments", "games" RESTART IDENTITY CASCADE');

    const { rows } = await pool.query(
      `INSERT INTO "games" ("title", "slug", "genre")
       VALUES ('Doom', 'doom', 'ACTION') RETURNING "id"`,
    );

    gameId = rows[0].id;
  });

  const post = (
    ip: string | undefined,
    content: string,
    parentId: number | null = null,
  ) => Comment.create({ nick: "n", content, gameId, parentId, ip });

  async function contents(): Promise<string[]> {
    const { rows } = await pool.query(
      'SELECT "content" FROM "comments" ORDER BY "id"',
    );

    return rows.map((row) => row.content);
  }

  describe("what is stored", () => {
    it("is a hash of the address, the same one for the same address", async () => {
      await post(FLOODER, "one");
      await post(FLOODER, "two");
      await post(NEIGHBOUR, "three");

      const { rows } = await pool.query(
        'SELECT "sourceHash" FROM "comments" ORDER BY "id"',
      );
      const [one, two, three] = rows.map((row) => row.sourceHash);

      expect(one).toMatch(/^[0-9a-f]{64}$/);
      expect(one).toBe(commentSource(FLOODER));
      expect(two).toBe(one);
      expect(three).not.toBe(one);
    });

    // Nowhere in the row, in any column — the privacy policy says the address
    // itself is not kept.
    it("never holds the address itself", async () => {
      await post(FLOODER, "one");

      const { rows } = await pool.query(
        'SELECT row_to_json(c)::text AS "row" FROM "comments" c',
      );

      expect(rows[0].row).not.toContain(FLOODER);
    });

    // Written by a later change that passed req.ip straight through, an
    // address would be personal data the policy says is not stored, and
    // nothing else would notice. The database refuses it — see 0056.
    it("refuses anything in the column that is not a hash", async () => {
      await expect(
        pool.query(
          `INSERT INTO "comments" ("nick", "content", "gameId", "sourceHash")
           VALUES ('n', 'c', $1, $2)`,
          [gameId, FLOODER],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("records no source for a comment with no address behind it", async () => {
      const comment = await post(undefined, "scripted");

      expect(comment.hasSource).toBe(false);
      expect(await Comment.findSameSource(comment.id)).toBeNull();
    });
  });

  describe("findSameSource", () => {
    it("counts and lists what the source posted, newest first", async () => {
      const first = await post(FLOODER, "spam 1");
      await post(NEIGHBOUR, "a real comment");
      await post(FLOODER, "spam 2");
      await post(FLOODER, "spam 3");

      const source = (await Comment.findSameSource(first.id))!;

      expect(source.total).toBe(3);
      expect(source.comments.map((c) => c.content)).toEqual([
        "spam 3",
        "spam 2",
        "spam 1",
      ]);
      expect(source.comments[0]).toMatchObject({
        gameTitle: "Doom",
        gameSlug: "doom",
        hasSource: true,
      });
    });

    /**
     * Replies from other sources go with the comments they answer — the
     * cascade the single delete has always had — and the review page says how
     * many, because that is the part a glance at the list would miss. Deep
     * ones count; a reply the source wrote to itself is counted once.
     */
    it("counts the replies from elsewhere that would go with them", async () => {
      const spam = await post(FLOODER, "spam");
      const answer = await post(NEIGHBOUR, "please stop", spam.id);
      await post(NEIGHBOUR, "seconded", answer.id);
      await post(FLOODER, "more spam", spam.id);
      await post(NEIGHBOUR, "unrelated");

      const source = (await Comment.findSameSource(spam.id))!;

      expect(source.total).toBe(2);
      expect(source.otherReplies).toBe(2);
    });

    it("lists at most the limit, while the count stays exact", async () => {
      const first = await post(FLOODER, "spam 1");
      await post(FLOODER, "spam 2");
      await post(FLOODER, "spam 3");

      const source = (await Comment.findSameSource(first.id, 2))!;

      expect(source.total).toBe(3);
      expect(source.comments).toHaveLength(2);
    });

    it("answers null for a comment that is not there", async () => {
      expect(await Comment.findSameSource(999_999)).toBeNull();
    });
  });

  describe("deleteSameSource", () => {
    it("deletes what the source posted and leaves everyone else", async () => {
      const spam = await post(FLOODER, "spam 1");
      await post(NEIGHBOUR, "a real comment");
      await post(FLOODER, "spam 2");

      expect(await Comment.deleteSameSource(spam.id)).toBe(2);
      expect(await contents()).toEqual(["a real comment"]);
    });

    // The same semantics as deleting one comment: its replies go with it,
    // whoever wrote them.
    it("takes the replies to them with them, from any source", async () => {
      const spam = await post(FLOODER, "spam");
      const answer = await post(NEIGHBOUR, "please stop", spam.id);
      await post(NEIGHBOUR, "seconded", answer.id);
      await post(NEIGHBOUR, "unrelated");

      await Comment.deleteSameSource(spam.id);

      expect(await contents()).toEqual(["unrelated"]);
    });

    /**
     * Exactly what the single delete drops: the Latest comments widget and the
     * "Most discussed" panel here, and the "comments" epoch that makes every
     * other machine drop the same two. A flood is precisely what those two
     * were showing.
     */
    it("drops the caches the single delete drops", async () => {
      const spam = await post(FLOODER, "spam");

      vi.mocked(bumpCacheEpoch).mockClear();
      await sidebarCache.get(LATEST_COMMENTS_KEY, 60_000, async () => []);
      await sidebarCache.get(MOST_DISCUSSED_KEY, 60_000, async () => []);

      await Comment.deleteSameSource(spam.id);

      expect(sidebarCache.has(LATEST_COMMENTS_KEY)).toBe(false);
      expect(sidebarCache.has(MOST_DISCUSSED_KEY)).toBe(false);
      expect(bumpCacheEpoch).toHaveBeenCalledWith("comments");
      expect(bumpCacheEpoch).toHaveBeenCalledTimes(1);
    });

    // A stale review page posted twice changes nothing, and must not throw
    // the sidebar away on every machine on its behalf.
    it("deletes and drops nothing when there is no source", async () => {
      const unsourced = await post(undefined, "scripted");
      await post(FLOODER, "spam");

      vi.mocked(bumpCacheEpoch).mockClear();
      await sidebarCache.get(LATEST_COMMENTS_KEY, 60_000, async () => []);

      expect(await Comment.deleteSameSource(unsourced.id)).toBe(0);
      expect(await contents()).toEqual(["scripted", "spam"]);
      expect(sidebarCache.has(LATEST_COMMENTS_KEY)).toBe(true);
      expect(bumpCacheEpoch).not.toHaveBeenCalled();
    });
  });

  describe("pruneSources", () => {
    /** Moves a comment's timestamp back, as the days going by would. */
    async function age(id: number, days: number) {
      await pool.query(
        `UPDATE "comments"
         SET "createdAt" = NOW() - make_interval(days => $2::int)
         WHERE "id" = $1`,
        [id, days],
      );
    }

    it("clears the source off comments past the window and keeps the comments", async () => {
      const old = await post(FLOODER, "old");
      const recent = await post(FLOODER, "recent");

      await age(old.id, SOURCE_RETENTION_DAYS + 1);

      expect(await Comment.pruneSources()).toBe(1);

      const { rows } = await pool.query(
        'SELECT "content", "sourceHash" FROM "comments" ORDER BY "id"',
      );

      expect(rows).toEqual([
        { content: "old", sourceHash: null },
        { content: "recent", sourceHash: commentSource(FLOODER) },
      ]);
      expect((await Comment.findById(recent.id))!.hasSource).toBe(true);
    });

    // After which nothing groups it any more, which is the point.
    it("leaves nothing to group a pruned comment with", async () => {
      const old = await post(FLOODER, "old");
      await post(FLOODER, "recent");

      await age(old.id, SOURCE_RETENTION_DAYS + 1);
      await Comment.pruneSources();

      expect(await Comment.findSameSource(old.id)).toBeNull();
      expect(await Comment.deleteSameSource(old.id)).toBe(0);
      expect(await contents()).toEqual(["old", "recent"]);
    });

    it("keeps going until the backlog is gone, however big the batch", async () => {
      for (let n = 0; n < 5; n++) {
        const comment = await post(FLOODER, `old ${n}`);

        await age(comment.id, SOURCE_RETENTION_DAYS + 10);
      }

      expect(await Comment.pruneSources(SOURCE_RETENTION_DAYS, 2)).toBe(5);

      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS "left" FROM "comments" WHERE "sourceHash" IS NOT NULL',
      );

      expect(rows[0].left).toBe(0);
    });

    it("finds nothing to do on a table with nothing old in it", async () => {
      await post(FLOODER, "recent");

      expect(await Comment.pruneSources()).toBe(0);
    });
  });

  /**
   * The lookup is served by the partial index 0056 creates. Partial indexes
   * are only used when the query's own WHERE implies the index's, which is
   * easy to lose by rewriting a query — so this asks the planner rather than
   * trusting that it still does.
   */
  it("finds a source's comments through its index", async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      // Every plan costed as if the table were large: on an empty test table
      // a sequential scan is always cheapest, which says nothing.
      await client.query("SET LOCAL enable_seqscan = off");

      const { rows } = await client.query(
        `EXPLAIN SELECT "id" FROM "comments"
         WHERE "sourceHash" = (SELECT "sourceHash" FROM "comments" WHERE "id" = $1)`,
        [1],
      );

      expect(rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
        "idx_comments_sourceHash",
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
