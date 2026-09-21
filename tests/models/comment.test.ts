import { beforeEach, describe, expect, it, vi } from "vitest";
import Comment, {
  COMMENTS_PAGE_SIZE,
  REPLIES_PER_ROOT,
} from "../../models/comment";
import db from "../../db";

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

      expect(mockDb.query).toHaveBeenCalledWith(
        'INSERT INTO "comments" ("nick", "content", "gameId", "parentId") VALUES ($1, $2, $3, $4) RETURNING *',
        [commentData.nick, commentData.content, commentData.gameId, null],
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
        'INSERT INTO "comments" ("nick", "content", "gameId", "parentId") VALUES ($1, $2, $3, $4) RETURNING *',
        [commentData.nick, commentData.content, commentData.gameId, null],
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
      [{ ...base, id: 2, nick: "b", content: "reply", parentId: 1 }],
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
        { ...base, id: 2, nick: "b", content: "reply", parentId: 1 },
        { ...base, id: 3, nick: "c", content: "reply to reply", parentId: 2 },
      ],
    );

    const result = await Comment.findByGameId(1);

    expect(result).toHaveLength(1);
    expect(result[0].replies.map((r) => r.id)).toEqual([2, 3]);
  });

  it("reports how many replies the cap left out", async () => {
    // What the window would have returned for a thread of 60: the first
    // REPLIES_PER_ROOT rows, each carrying the partition's full count.
    mockBatch(
      [{ ...base, id: 1, nick: "a", content: "top", parentId: null }],
      [
        { ...base, id: 2, nick: "b", content: "r", parentId: 1, replyTotal: 60 },
        { ...base, id: 3, nick: "c", content: "r", parentId: 1, replyTotal: 60 },
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
      ["b", "reply", 1, 1],
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
