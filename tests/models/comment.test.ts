import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Comment, {
  COMMENTS_PAGE_SIZE,
  REPLIES_PER_ROOT,
  commentSource,
} from "../../models/comment";
import db from "../../db";
import { SESSION_SECRET } from "../../utils/session-secret";

vi.mock("../../db", () => ({
  default: {
    query: vi.fn(),
  },
}));

const mockDb = vi.mocked(db);

describe("Comment Model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should create a Comment instance with all properties", () => {
      const commentData = {
        id: 1,
        nick: "TestUser",
        content: "This is a test comment",
        gameId: 42,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      const comment = new Comment(commentData);

      expect(comment.id).toBe(commentData.id);
      expect(comment.nick).toBe(commentData.nick);
      expect(comment.content).toBe(commentData.content);
      expect(comment.gameId).toBe(commentData.gameId);
      expect(comment.createdAt).toBe(commentData.createdAt);
      expect(comment.updatedAt).toBe(commentData.updatedAt);
      expect(comment.deletedAt).toBe(commentData.deletedAt);
    });

    it("should create a Comment instance with string dates", () => {
      const commentData = {
        id: 2,
        nick: "AnotherUser",
        content: "Another test comment",
        gameId: 24,
        createdAt: "2025-06-09T10:00:00Z",
        updatedAt: "2025-06-09T10:00:00Z",
        deletedAt: null,
      };

      const comment = new Comment(commentData);

      expect(comment.id).toBe(commentData.id);
      expect(comment.nick).toBe(commentData.nick);
      expect(comment.content).toBe(commentData.content);
      expect(comment.gameId).toBe(commentData.gameId);
      expect(comment.createdAt).toBe(commentData.createdAt);
      expect(comment.updatedAt).toBe(commentData.updatedAt);
      expect(comment.deletedAt).toBe(commentData.deletedAt);
    });
  });

  describe("findByGameId", () => {
    const row = (id: number, overrides: Record<string, unknown> = {}) => ({
      id,
      nick: `player${id}`,
      content: `Comment ${id}`,
      gameId: 42,
      parentId: null,
      createdAt: new Date("2026-06-09T10:00:00Z"),
      updatedAt: new Date("2026-06-09T10:00:00Z"),
      deletedAt: null,
      ...overrides,
    });

    /** The model runs a roots query, then a replies query when roots exist. */
    function mockBatch(roots: any[], replies: any[] = []) {
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: roots })
        .mockResolvedValueOnce({ rows: replies });
    }

    it("asks for the newest top-level comments first", async () => {
      mockBatch([row(2), row(1)]);

      await Comment.findByGameId(42);

      const [sql, values] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('"parentId" IS NULL');
      expect(sql).toContain('ORDER BY "id" DESC');
      expect(values).toEqual([42, null, COMMENTS_PAGE_SIZE]);
    });

    it("returns them oldest-first so the thread reads chronologically", async () => {
      mockBatch([row(3), row(2), row(1)]);

      const result = await Comment.findByGameId(42);

      expect(result.map((c) => c.id)).toEqual([1, 2, 3]);
      expect(result[0]).toBeInstanceOf(Comment);
    });

    it("pages backwards from a cursor instead of using an offset", async () => {
      // An offset would shift under new comments and duplicate or skip rows.
      mockBatch([row(5)]);

      await Comment.findByGameId(42, { before: 6 });

      const [sql, values] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('"id" < $2');
      expect(values).toEqual([42, 6, COMMENTS_PAGE_SIZE]);
    });

    it("honours a custom batch size", async () => {
      mockBatch([row(1)]);

      await Comment.findByGameId(42, { limit: 3 });

      expect((mockDb.query as any).mock.calls[0][1]).toEqual([42, null, 3]);
    });

    it("returns an empty array and skips the replies query when there is nothing", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      const result = await Comment.findByGameId(999);

      expect(result).toEqual([]);
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it("fetches replies for exactly the roots in the batch", async () => {
      mockBatch([row(2), row(1)]);

      await Comment.findByGameId(42);

      const [sql, values] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain("WITH RECURSIVE");
      expect(values).toEqual([[1, 2], REPLIES_PER_ROOT]);
    });

    it("caps the replies per thread rather than per parent", async () => {
      mockBatch([row(1)]);

      await Comment.findByGameId(42);

      const [sql, values] = (mockDb.query as any).mock.calls[1];

      // One walk per root, with the cap inside it. Capping per immediate
      // parent would give every parent in a chain its own budget of fifty and
      // leave the thread as a whole as unbounded as it was, which is the bug
      // this window exists to close — so the lateral and its LIMIT are the
      // assertion.
      expect(sql).toContain("CROSS JOIN LATERAL");
      expect(sql).toContain("LIMIT $2");
      expect(values[1]).toBe(REPLIES_PER_ROOT);
    });

    // The count is what "12 more replies" renders, so it has to be the whole
    // thread's — evaluated before the LIMIT above cuts the page down.
    it("counts the whole thread before it applies the cap", async () => {
      mockBatch([row(1)]);

      await Comment.findByGameId(42);

      const [sql] = (mockDb.query as any).mock.calls[1];

      expect(sql).toContain('COUNT(*) OVER () AS "replyTotal"');
    });

    // Only the ids travel through the recursion; the columns are read once,
    // for the rows that survived the cap.
    it("walks ids and joins the rows back on afterwards", async () => {
      mockBatch([row(1)]);

      await Comment.findByGameId(42);

      const [sql] = (mockDb.query as any).mock.calls[1];

      expect(sql).toContain('JOIN "comments" c ON c."id" = w."id"');
    });
  });
  describe("create", () => {
    it("should create a new comment", async () => {
      const commentData = {
        nick: "NewUser",
        content: "This is a new comment",
        gameId: 123,
      };

      const mockResult = {
        rows: [
          {
            id: 1,
            nick: commentData.nick,
            content: commentData.content,
            gameId: commentData.gameId,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          },
        ],
      };

      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await Comment.create(commentData);

      // No address, so no source: the fifth value is the "sourceHash", and
      // a comment created without a request behind it has none to record.
      expect(mockDb.query).toHaveBeenCalledWith(
        'INSERT INTO "comments" ("nick", "content", "gameId", "parentId", "sourceHash") VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [commentData.nick, commentData.content, commentData.gameId, null, null],
      );
      expect(result).toBeInstanceOf(Comment);
      expect(result.nick).toBe(commentData.nick);
      expect(result.content).toBe(commentData.content);
      expect(result.gameId).toBe(commentData.gameId);
      expect(result.id).toBe(1);
    });

    it("should handle special characters in comment content", async () => {
      const commentData = {
        nick: "SpecialUser",
        content:
          "Comment with special chars: <script>alert('test')</script> & symbols",
        gameId: 456,
      };

      const mockResult = {
        rows: [
          {
            id: 2,
            nick: commentData.nick,
            content: commentData.content,
            gameId: commentData.gameId,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          },
        ],
      };

      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await Comment.create(commentData);

      expect(mockDb.query).toHaveBeenCalledWith(
        'INSERT INTO "comments" ("nick", "content", "gameId", "parentId", "sourceHash") VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [commentData.nick, commentData.content, commentData.gameId, null, null],
      );
      expect(result.content).toBe(commentData.content);
    });

    it("should handle unicode characters in nick and content", async () => {
      const commentData = {
        nick: "Uživatel_123",
        content: "Komentář s českými znaky: ářžšýáí",
        gameId: 789,
      };

      const mockResult = {
        rows: [
          {
            id: 3,
            nick: commentData.nick,
            content: commentData.content,
            gameId: commentData.gameId,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          },
        ],
      };

      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await Comment.create(commentData);

      expect(result.nick).toBe(commentData.nick);
      expect(result.content).toBe(commentData.content);
    });
  });
});

describe("Comment Model — threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const base = {
    createdAt: new Date("2026-01-01T10:00:00Z"),
    updatedAt: new Date("2026-01-01T10:00:00Z"),
    deletedAt: null,
    gameId: 1,
  };

  function mockBatch(roots: any[], replies: any[] = []) {
    (mockDb.query as any)
      .mockResolvedValueOnce({ rows: roots })
      .mockResolvedValueOnce({ rows: replies });
  }

  it("nests replies under the comment they answer", async () => {
    mockBatch(
      [
        { ...base, id: 3, nick: "c", content: "other top", parentId: null },
        { ...base, id: 1, nick: "a", content: "top", parentId: null },
      ],
      // "rootId" is the thread the query found the reply under, which is
      // what files it — see findByGameId.
      [{ ...base, id: 2, nick: "b", content: "reply", parentId: 1, rootId: 1 }],
    );

    const result = await Comment.findByGameId(1);

    expect(result.map((c) => c.id)).toEqual([1, 3]);
    expect(result[0].replies).toHaveLength(1);
    expect(result[0].replies[0].content).toBe("reply");
    expect(result[1].replies).toHaveLength(0);
  });

  it("flattens deeper nesting onto the top-level ancestor", async () => {
    // A long reply chain would otherwise march off the side of the page.
    mockBatch(
      [{ ...base, id: 1, nick: "a", content: "top", parentId: null }],
      [
        { ...base, id: 2, nick: "b", content: "reply", parentId: 1, rootId: 1 },
        {
          ...base,
          id: 3,
          nick: "c",
          content: "reply to reply",
          parentId: 2,
          rootId: 1,
        },
      ],
    );

    const result = await Comment.findByGameId(1);

    expect(result).toHaveLength(1);
    expect(result[0].replies.map((r) => r.id)).toEqual([2, 3]);
  });

  it("reports how many replies the cap left out", async () => {
    // What the window would have returned for a thread of 60: its newest
    // REPLIES_PER_ROOT rows, each carrying the partition's full count.
    mockBatch(
      [{ ...base, id: 1, nick: "a", content: "top", parentId: null }],
      [
        { ...base, id: 2, nick: "b", content: "r", parentId: 1, replyTotal: 60, rootId: 1 },
        { ...base, id: 3, nick: "c", content: "r", parentId: 1, replyTotal: 60, rootId: 1 },
      ],
    );

    const result = await Comment.findByGameId(1);

    expect(result[0].replies).toHaveLength(2);
    expect(result[0].hiddenReplies).toBe(60 - REPLIES_PER_ROOT);
  });

  it("reports nothing hidden when the thread fits", async () => {
    mockBatch(
      [{ ...base, id: 1, nick: "a", content: "top", parentId: null }],
      [{ ...base, id: 2, nick: "b", content: "reply", parentId: 1, replyTotal: 1 }],
    );

    const result = await Comment.findByGameId(1);

    expect(result[0].hiddenReplies).toBe(0);
  });

  it("reports nothing hidden for a root with no replies at all", async () => {
    mockBatch([{ ...base, id: 1, nick: "a", content: "top", parentId: null }]);

    const result = await Comment.findByGameId(1);

    expect(result[0].hiddenReplies).toBe(0);
  });

  it("drops a reply whose thread is not in this batch", async () => {
    // The recursive query only returns descendants of the loaded roots, so
    // this should not happen — but an orphan must not crash the render.
    mockBatch(
      [{ ...base, id: 1, nick: "a", content: "top", parentId: null }],
      [{ ...base, id: 9, nick: "x", content: "orphan", parentId: 99 }],
    );

    const result = await Comment.findByGameId(1);

    expect(result).toHaveLength(1);
    expect(result[0].replies).toHaveLength(0);
  });

  it("stores the parent id when creating a reply", async () => {
    (mockDb.query as any).mockResolvedValueOnce({
      rows: [{ ...base, id: 5, nick: "b", content: "reply", parentId: 1 }],
    });

    const result = await Comment.create({
      nick: "b",
      content: "reply",
      gameId: 1,
      parentId: 1,
    });

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('"parentId"'),
      ["b", "reply", 1, 1, null],
    );
    expect(result.parentId).toBe(1);
  });
});

describe("Comment Model — counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts only top-level comments for paging", async () => {
    (mockDb.query as any).mockResolvedValueOnce({ rows: [{ count: "7" }] });

    expect(await Comment.countRoots(42)).toBe(7);
    expect((mockDb.query as any).mock.calls[0][0]).toContain(
      '"parentId" IS NULL',
    );
  });

  it("counts replies too for the heading", async () => {
    (mockDb.query as any).mockResolvedValueOnce({ rows: [{ count: "23" }] });

    expect(await Comment.countAll(42)).toBe(23);
    expect((mockDb.query as any).mock.calls[0][0]).not.toContain(
      '"parentId" IS NULL',
    );
  });

  it("counts how many older comments are still unloaded", async () => {
    (mockDb.query as any).mockResolvedValueOnce({ rows: [{ count: "12" }] });

    expect(await Comment.countOlderThan(42, 100)).toBe(12);
    expect((mockDb.query as any).mock.calls[0][1]).toEqual([42, 100]);
  });

  it("reports zero when the table has no rows for the game", async () => {
    (mockDb.query as any).mockResolvedValueOnce({ rows: [{ count: "0" }] });

    expect(await Comment.countRoots(42)).toBe(0);
  });
});

/**
 * The overview used to put LIMIT/OFFSET on top of the join to "games", so
 * every comment a deep page skipped was joined to its game first and then
 * thrown away — work that grew with the square of the comment count across a
 * crawl. The page is now chosen from ids alone.
 */
describe("Comment Model — the site-wide overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pages over ids before anything is joined", async () => {
    (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

    await Comment.findRecent({ limit: 30, offset: 90_000 });

    const [sql, values] = (mockDb.query as any).mock.calls[0];
    const inner = /FROM \(\s*SELECT "id" FROM "comments"\s*ORDER BY "id" DESC\s*LIMIT \$1 OFFSET \$2\s*\) page/.exec(
      sql,
    );

    expect(inner).not.toBeNull();
    expect(sql.indexOf('JOIN "games"')).toBeGreaterThan(inner!.index);
    expect(values).toEqual([30, 90_000]);
  });
});

/**
 * The source recorded with a comment, which is what lets moderation take down
 * everything one flood posted in one action (see POST /comments/:id/source in
 * routes/comments.ts). It has to group what the comment limiter groups, and
 * it must not be the address.
 */
describe("commentSource", () => {
  it("is a hash, not the address it came from", () => {
    const source = commentSource("203.0.113.7")!;

    expect(source).toMatch(/^[0-9a-f]{64}$/);
    expect(source).not.toContain("203.0.113.7");
  });

  it("is the same for the same address", () => {
    expect(commentSource("203.0.113.7")).toBe(commentSource("203.0.113.7"));
  });

  it("tells two IPv4 addresses apart, however close", () => {
    expect(commentSource("203.0.113.7")).not.toBe(commentSource("203.0.113.8"));
  });

  // What a dual-stack socket reports for an IPv4 client. Left as it was, the
  // same visitor would be two sources depending on how they connected.
  it("reads an IPv6-mapped IPv4 address as the address it maps", () => {
    expect(commentSource("::ffff:203.0.113.7")).toBe(
      commentSource("203.0.113.7"),
    );
  });

  /**
   * One source per rate-limit budget. The comment limiter counts an IPv6
   * client by its /56, and one budget holds 256 /64s — so a source any finer
   * would let a flood put every comment on a network of its own, and the
   * "delete all from this source" it exists for would find one comment each
   * time.
   */
  it("groups an IPv6 client by the /56 the limiter counts it by", () => {
    const one = commentSource("2001:db8:1234:5600::1");

    // Another /64 inside the same /56, and another host inside that.
    expect(commentSource("2001:db8:1234:56ff:abcd::2")).toBe(one);
    expect(commentSource("2001:db8:1234:5601:1:2:3:4")).toBe(one);
    // The next /56 along is somebody else.
    expect(commentSource("2001:db8:1234:5700::1")).not.toBe(one);
  });

  it("records nothing when there is no address to hash", () => {
    expect(commentSource(undefined)).toBeNull();
    expect(commentSource(null)).toBeNull();
    expect(commentSource("")).toBeNull();
  });

  /**
   * Keyed for this purpose alone. A hash under SESSION_SECRET itself would be
   * the value express-session signs a session id with, for anything shaped
   * like an address — and a bare digest of an IPv4 address is reversed by
   * trying all four billion of them.
   */
  it("is keyed for comment sources alone", () => {
    const address = "203.0.113.7";

    expect(commentSource(address)).not.toBe(
      crypto.createHmac("sha256", SESSION_SECRET).update(address).digest("hex"),
    );
    expect(commentSource(address)).not.toBe(
      crypto.createHash("sha256").update(address).digest("hex"),
    );
  });
});

describe("Comment Model — sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const row = {
    id: 1,
    nick: "a",
    content: "c",
    gameId: 1,
    parentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // The address goes no further than the model: what is written is its hash.
  it("stores the hash of the address it was given, never the address", async () => {
    (mockDb.query as any).mockResolvedValueOnce({ rows: [row] });

    await Comment.create({
      nick: "a",
      content: "c",
      gameId: 1,
      ip: "203.0.113.7",
    });

    const [, values] = (mockDb.query as any).mock.calls[0];

    expect(values).toHaveLength(5);
    expect(values[4]).toBe(commentSource("203.0.113.7"));
    expect(values).not.toContain("203.0.113.7");
  });

  /**
   * A flag on the instance, and not the hash. Every view is handed the
   * instance, and the route tests serialise it whole, so the hash would be
   * one careless template from the page.
   */
  it("says whether a source is recorded without carrying it", () => {
    const hash = "a".repeat(64);
    const withSource = new Comment({ ...row, sourceHash: hash });
    const without = new Comment({ ...row, sourceHash: null });

    expect(withSource.hasSource).toBe(true);
    expect(without.hasSource).toBe(false);
    expect(JSON.stringify(withSource)).not.toContain(hash);
  });

  it("reads a row from before sources as having none", () => {
    expect(new Comment(row).hasSource).toBe(false);
  });
});
