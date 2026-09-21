import { beforeEach, describe, expect, it, vi } from "vitest";
import GameOfTheWeek from "../../models/game-of-the-week.ts";
import Game from "../../models/game.ts";
import db from "../../db.ts";

vi.mock("../../db", () => ({
  default: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

// A constructor, not a bag of statics: getCurrent builds the game from the
// row the join returned rather than asking Game.findById for it. findById is
// still mocked so the assertions that it is *not* called mean something.
vi.mock("../../models/game", () => {
  class MockGame {
    averageRating?: number;
    ratingCount?: number;

    constructor(data: Record<string, unknown>) {
      Object.assign(this, data);
    }

    static findById = vi.fn();
  }

  return { default: MockGame };
});

const mockDb = vi.mocked(db);
const mockGame = vi.mocked(Game, true);

/** A checked-out client for the paths that select behind an advisory lock. */
function mockPoolClient() {
  const client = { query: vi.fn(), release: vi.fn() };

  (mockDb.connect as any).mockResolvedValue(client);

  return client;
}

describe("GameOfTheWeek Model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should create a GameOfTheWeek instance with all properties", () => {
      const gameOfTheWeekData = {
        id: 1,
        gameId: 42,
        startDate: new Date("2025-06-09T00:00:00Z"),
        endDate: new Date("2025-06-16T23:59:59Z"),
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      const gameOfTheWeek = new GameOfTheWeek(gameOfTheWeekData);

      expect(gameOfTheWeek.id).toBe(gameOfTheWeekData.id);
      expect(gameOfTheWeek.gameId).toBe(gameOfTheWeekData.gameId);
      expect(gameOfTheWeek.startDate).toBe(gameOfTheWeekData.startDate);
      expect(gameOfTheWeek.endDate).toBe(gameOfTheWeekData.endDate);
      expect(gameOfTheWeek.createdAt).toBe(gameOfTheWeekData.createdAt);
      expect(gameOfTheWeek.updatedAt).toBe(gameOfTheWeekData.updatedAt);
      expect(gameOfTheWeek.deletedAt).toBe(gameOfTheWeekData.deletedAt);
    });

    it("should create a GameOfTheWeek instance with string dates", () => {
      const gameOfTheWeekData = {
        id: 2,
        gameId: 24,
        startDate: "2025-06-09T00:00:00Z",
        endDate: "2025-06-16T23:59:59Z",
        createdAt: "2025-06-09T10:00:00Z",
        updatedAt: "2025-06-09T10:00:00Z",
        deletedAt: null,
      };

      const gameOfTheWeek = new GameOfTheWeek(gameOfTheWeekData);

      expect(gameOfTheWeek.id).toBe(gameOfTheWeekData.id);
      expect(gameOfTheWeek.gameId).toBe(gameOfTheWeekData.gameId);
      expect(gameOfTheWeek.startDate).toBe(gameOfTheWeekData.startDate);
      expect(gameOfTheWeek.endDate).toBe(gameOfTheWeekData.endDate);
      expect(gameOfTheWeek.createdAt).toBe(gameOfTheWeekData.createdAt);
      expect(gameOfTheWeek.updatedAt).toBe(gameOfTheWeekData.updatedAt);
      expect(gameOfTheWeek.deletedAt).toBe(gameOfTheWeekData.deletedAt);
    });
  });

  describe("getCurrent", () => {
    /**
     * The pick and its game come back together now — one join rather than a
     * select followed by Game.findById with the id it found. The game's own
     * columns arrive under "gameRow" as JSON, because both tables have an
     * "id", a "createdAt" and an "updatedAt".
     */
    const CURRENT_SQL = `SELECT gw.*, to_jsonb(g.*) AS "gameRow",
              COALESCE(AVG(r."rating"), 0) AS "averageRating",
              COUNT(r."rating") AS "ratingCount"
       FROM "game_of_the_week" gw
       JOIN "games" g ON g."id" = gw."gameId"
       LEFT JOIN "ratings" r ON r."gameId" = g."id"
       WHERE NOW() BETWEEN gw."startDate" AND gw."endDate"
       GROUP BY gw."id", g."id"
       ORDER BY gw."startDate" DESC
       LIMIT 1`;

    it("returns the current pick with its game, in one query", async () => {
      (mockDb.query as any).mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            gameId: 42,
            startDate: new Date("2025-06-09T00:00:00Z"),
            endDate: new Date("2025-06-16T23:59:59Z"),
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            gameRow: {
              id: 42,
              title: "Test Game",
              slug: "test-game",
              description: "A test game",
            },
            // Strings, as node-postgres hands numeric and bigint back.
            averageRating: "4.5",
            ratingCount: "8",
          },
        ],
      });

      const result = await GameOfTheWeek.getCurrent();

      expect(mockDb.query).toHaveBeenCalledWith(CURRENT_SQL);
      // The whole point of the join: no second round trip for the game.
      expect(mockGame.findById).not.toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(result).toBeInstanceOf(GameOfTheWeek);
      expect(result?.gameId).toBe(42);
      expect(result?.game?.title).toBe("Test Game");
      expect(result?.game?.averageRating).toBe(4.5);
      expect(result?.game?.ratingCount).toBe(8);
    });

    it("should return null when no current game of the week exists", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      const result = await GameOfTheWeek.getCurrent();

      expect(mockDb.query).toHaveBeenCalledWith(CURRENT_SQL);
      expect(mockGame.findById).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  describe("selectNewGameOfTheWeek", () => {
    it("should select a new game of the week from eligible games", async () => {
      const mockEligibleGames = [{ id: 123 }];
      const mockNewGameOfTheWeek = {
        id: 2,
        gameId: 123,
        startDate: new Date(),
        endDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: mockEligibleGames })
        .mockResolvedValueOnce({ rows: [mockNewGameOfTheWeek] });

      const result = await GameOfTheWeek.selectNewGameOfTheWeek();

      // The conditions rather than the statement byte for byte: what the
      // eligibility query has to say is that a game just featured is out, a
      // badly rated one is out, and — the one that was missing — a game with
      // nothing to launch is out. See the rollover suite for the rows it
      // actually returns.
      const [eligibilitySql] = (mockDb.query as any).mock.calls[0];
      expect(eligibilitySql).toContain(`WHERE recent."gameId" IS NULL`);
      expect(eligibilitySql).toContain(
        `g."stream" IS NOT NULL AND g."stream" <> ''`,
      );
      expect(eligibilitySql).toContain(
        "(r.avg_rating IS NULL OR r.avg_rating >= 4)",
      );
      expect(mockDb.query).toHaveBeenCalledWith(
        `INSERT INTO "game_of_the_week" ("gameId")
       VALUES ($1)
       RETURNING *`,
        [123],
      );
      expect(result).toBeInstanceOf(GameOfTheWeek);
      expect(result?.gameId).toBe(123);
    });

    it("should select any game when no eligible games found", async () => {
      const mockAnyGame = [{ id: 456 }];
      const mockNewGameOfTheWeek = {
        id: 3,
        gameId: 456,
        startDate: new Date(),
        endDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: mockAnyGame })
        .mockResolvedValueOnce({ rows: [mockNewGameOfTheWeek] });

      const result = await GameOfTheWeek.selectNewGameOfTheWeek();

      const [eligibilitySql] = (mockDb.query as any).mock.calls[0];
      expect(eligibilitySql).toContain(`WHERE recent."gameId" IS NULL`);

      // The fallback keeps the one condition it cannot drop. It exists to pick
      // *something* when every eligible game has been featured recently, and
      // it used to reach for the whole catalogue — including the games with no
      // stream that the query above had just excluded.
      const [fallbackSql] = (mockDb.query as any).mock.calls[1];
      expect(fallbackSql).toContain('SELECT id FROM "games"');
      expect(fallbackSql).toContain(
        `WHERE "stream" IS NOT NULL AND "stream" <> ''`,
      );
      expect(fallbackSql).toContain("ORDER BY RANDOM() LIMIT 1");
      expect(mockDb.query).toHaveBeenNthCalledWith(
        3,
        `INSERT INTO "game_of_the_week" ("gameId")
       VALUES ($1)
       RETURNING *`,
        [456],
      );
      expect(result).toBeInstanceOf(GameOfTheWeek);
      expect(result?.gameId).toBe(456);
    });

    it("should return null when no games exist at all", async () => {
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await GameOfTheWeek.selectNewGameOfTheWeek();

      expect(mockDb.query).toHaveBeenCalledTimes(2);
      expect(result).toBeNull();
    });
  });

  describe("getOrSelectCurrent", () => {
    it("should return current game of the week if it exists", async () => {
      const mockCurrentGameOfTheWeek = {
        id: 1,
        gameId: 42,
        startDate: new Date("2025-06-09T00:00:00Z"),
        endDate: new Date("2025-06-16T23:59:59Z"),
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      (mockDb.query as any).mockResolvedValueOnce({
        rows: [
          {
            ...mockCurrentGameOfTheWeek,
            gameRow: {
              id: 42,
              title: "Current Game",
              slug: "current-game",
              description: "Current game description",
            },
            averageRating: "4.2",
            ratingCount: "3",
          },
        ],
      });

      const result = await GameOfTheWeek.getOrSelectCurrent();

      expect(result).toBeInstanceOf(GameOfTheWeek);
      expect(result?.gameId).toBe(42);
      expect(result?.game).toBeDefined();
      expect(result?.game?.averageRating).toBe(4.2);
    });

    it("should select new game of the week if no current exists", async () => {
      const mockNewGameOfTheWeek = {
        id: 2,
        gameId: 123,
        startDate: new Date(),
        endDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      const client = mockPoolClient();

      (client.query as any)
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({ rows: [] }) // nobody else picked yet
        .mockResolvedValueOnce({ rows: [{ id: 123 }] }) // candidate game
        .mockResolvedValueOnce({ rows: [mockNewGameOfTheWeek] }) // insert
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] }) // no current pick
        .mockResolvedValueOnce({ rows: [mockNewGameOfTheWeek] }); // re-read

      mockGame.findById.mockResolvedValueOnce({ id: 123 } as any);

      const result = await GameOfTheWeek.getOrSelectCurrent();

      expect(result).toBeInstanceOf(GameOfTheWeek);
      expect(result?.gameId).toBe(123);
      expect(client.release).toHaveBeenCalled();
    });

    // Concurrent requests arriving in the gap between two weeks each used to
    // insert their own pick.
    it("should serialize selection behind an advisory lock", async () => {
      const client = mockPoolClient();

      (client.query as any).mockResolvedValue({ rows: [] });
      (mockDb.query as any).mockResolvedValue({ rows: [] });

      await GameOfTheWeek.getOrSelectCurrent();

      expect(client.query).toHaveBeenCalledWith("BEGIN");
      expect(client.query).toHaveBeenCalledWith(
        "SELECT pg_advisory_xact_lock($1)",
        [expect.any(Number)],
      );
      expect(client.query).toHaveBeenCalledWith("COMMIT");
    });

    // Someone else won the lock and made the pick while this request waited.
    it("should not insert a second pick when one appeared while waiting", async () => {
      const client = mockPoolClient();

      (client.query as any)
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }) // already picked
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 9, gameId: 7 }] });

      mockGame.findById.mockResolvedValueOnce({ id: 7 } as any);

      const result = await GameOfTheWeek.getOrSelectCurrent();

      expect(result?.gameId).toBe(7);
      expect(client.query).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "game_of_the_week"'),
        expect.anything(),
      );
    });

    it("should release the client and rethrow when selection fails", async () => {
      const client = mockPoolClient();

      (client.query as any)
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(new Error("lock failed"))
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await expect(GameOfTheWeek.getOrSelectCurrent()).rejects.toThrow(
        "lock failed",
      );

      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalled();
    });

    it("should return null if no current game exists and no games can be selected", async () => {
      const client = mockPoolClient();

      (client.query as any).mockResolvedValue({ rows: [] });
      (mockDb.query as any).mockResolvedValue({ rows: [] });

      const result = await GameOfTheWeek.getOrSelectCurrent();

      expect(result).toBeNull();
    });
  });
});
