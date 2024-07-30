import { beforeEach, describe, expect, it, vi } from "vitest";
import Comment from "../../models/comment";
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
    it("should find comments by game ID", async () => {
      const gameId = 42;
      const mockComments = [
        {
          id: 1,
          nick: "Player1",
          content: "Great game!",
          gameId: 42,
          createdAt: new Date("2025-06-09T10:00:00Z"),
          updatedAt: new Date("2025-06-09T10:00:00Z"),
          deletedAt: null,
        },
        {
          id: 2,
          nick: "Player2",
          content: "I love this game!",
          gameId: 42,
          createdAt: new Date("2025-06-09T11:00:00Z"),
          updatedAt: new Date("2025-06-09T11:00:00Z"),
          deletedAt: null,
        },
      ];

      (mockDb.query as any).mockResolvedValueOnce({ rows: mockComments });

      const result = await Comment.findByGameId(gameId);

      expect(mockDb.query).toHaveBeenCalledWith(
        'SELECT * FROM "comments" WHERE "gameId" = $1 ORDER BY "createdAt" ASC LIMIT 100',
        [gameId]
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(Comment);
      expect(result[1]).toBeInstanceOf(Comment);
      expect(result[0].nick).toBe("Player1");
      expect(result[1].nick).toBe("Player2");
      expect(result[0].gameId).toBe(gameId);
      expect(result[1].gameId).toBe(gameId);
    });

    it("should return empty array when no comments found for game", async () => {
      const gameId = 999;

      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      const result = await Comment.findByGameId(gameId);

      expect(mockDb.query).toHaveBeenCalledWith(
        'SELECT * FROM "comments" WHERE "gameId" = $1 ORDER BY "createdAt" ASC LIMIT 100',
        [gameId]
      );
      expect(result).toEqual([]);
    });

    it("should limit results to 100 comments", async () => {
      const gameId = 42;

      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Comment.findByGameId(gameId);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT 100"),
        [gameId]
      );
    });

    it("should order comments by creation date ascending", async () => {
      const gameId = 42;

      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Comment.findByGameId(gameId);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY "createdAt" ASC'),
        [gameId]
      );
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
        'INSERT INTO "comments" ("nick", "content", "gameId") VALUES ($1, $2, $3) RETURNING *',
        [commentData.nick, commentData.content, commentData.gameId]
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
        'INSERT INTO "comments" ("nick", "content", "gameId") VALUES ($1, $2, $3) RETURNING *',
        [commentData.nick, commentData.content, commentData.gameId]
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
