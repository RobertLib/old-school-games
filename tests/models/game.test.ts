import { beforeEach, describe, expect, it, vi } from "vitest";
import Game from "../../models/game.ts";
import db from "../../db.ts";

vi.mock("../../db", () => ({
  default: {
    query: vi.fn(),
  },
}));

const mockDb = vi.mocked(db);

describe("Game Model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should create a Game instance with all properties", () => {
      const gameData = {
        id: 1,
        title: "Test Game",
        slug: "test-game",
        description: "A test game description",
        genre: "ACTION",
        release: 1990,
        developer: "Test Developer",
        publisher: "Test Publisher",
        images: ["image1.jpg", "image2.jpg"],
        stream: "test-stream.zip",
        manual: "test-manual.pdf",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      const game = new Game(gameData);

      expect(game.id).toBe(gameData.id);
      expect(game.title).toBe(gameData.title);
      expect(game.slug).toBe(gameData.slug);
      expect(game.description).toBe(gameData.description);
      expect(game.genre).toBe(gameData.genre);
      expect(game.release).toBe(gameData.release);
      expect(game.developer).toBe(gameData.developer);
      expect(game.publisher).toBe(gameData.publisher);
      expect(game.images).toEqual(gameData.images);
      expect(game.stream).toBe(gameData.stream);
      expect(game.manual).toBe(gameData.manual);
      expect(game.createdAt).toBe(gameData.createdAt);
      expect(game.updatedAt).toBe(gameData.updatedAt);
      expect(game.deletedAt).toBe(gameData.deletedAt);
    });

    it("should create a Game instance with null release date", () => {
      const gameData = {
        id: 2,
        title: "Another Game",
        slug: "another-game",
        description: "Another game description",
        genre: "STRATEGY",
        release: null,
        developer: "Another Developer",
        publisher: "Another Publisher",
        images: [],
        stream: "",
        manual: "",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      const game = new Game(gameData);

      expect(game.release).toBeNull();
      expect(game.images).toEqual([]);
      expect(game.stream).toBe("");
      expect(game.manual).toBe("");
    });
  });

  describe("createSlug", () => {
    it("should create a slug from title", () => {
      expect(Game.createSlug("Test Game")).toBe("test-game");
      expect(Game.createSlug("Super Mario Bros.")).toBe("super-mario-bros");
      expect(Game.createSlug("Game with Special Characters!@#")).toBe(
        "game-with-special-characters"
      );
      expect(Game.createSlug("Multiple   Spaces")).toBe("multiple-spaces");
      expect(Game.createSlug("-Leading and Trailing-")).toBe(
        "leading-and-trailing"
      );
    });
  });

  describe("getGenres", () => {
    it("should return cached genres if available", async () => {
      (Game as any).cachedGenres = ["ACTION", "STRATEGY"];

      const genres = await Game.getGenres();

      expect(genres).toEqual(["ACTION", "STRATEGY"]);
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it("should fetch and cache genres from database", async () => {
      (Game as any).cachedGenres = null;

      const mockResult = {
        rows: [{ genres: "{ACTION,STRATEGY,RPG}" }],
      };

      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const genres = await Game.getGenres();

      expect(mockDb.query).toHaveBeenCalledWith(
        "SELECT enum_range(NULL::GAME_GENRE) AS genres"
      );
      expect(genres).toEqual(["ACTION", "STRATEGY", "RPG"]);
      expect((Game as any).cachedGenres).toEqual(["ACTION", "STRATEGY", "RPG"]);
    });
  });

  describe("findById", () => {
    it("should find game by ID", async () => {
      const mockGameData = {
        id: 1,
        title: "Found Game",
        slug: "found-game",
        description: "Found game description",
        genre: "ACTION",
        release: 1995,
        developer: "Found Developer",
        publisher: "Found Publisher",
        images: ["found.jpg"],
        stream: "found.zip",
        manual: "found.pdf",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      (mockDb.query as any).mockResolvedValueOnce({ rows: [mockGameData] });

      const result = await Game.findById(1);

      expect(mockDb.query).toHaveBeenCalledWith(
        'SELECT * FROM "games" WHERE "id" = $1',
        [1]
      );
      expect(result).toBeInstanceOf(Game);
      expect(result?.title).toBe("Found Game");
    });

    it("should return null when game not found", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      const result = await Game.findById(999);

      expect(mockDb.query).toHaveBeenCalledWith(
        'SELECT * FROM "games" WHERE "id" = $1',
        [999]
      );
      expect(result).toBeNull();
    });
  });

  describe("findBySlug", () => {
    it("should find game by slug with average rating", async () => {
      const mockGameData = {
        id: 1,
        title: "Slug Game",
        slug: "slug-game",
        description: "Slug game description",
        genre: "RPG",
        release: 2000,
        developer: "Slug Developer",
        publisher: "Slug Publisher",
        images: [],
        stream: "",
        manual: "",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [mockGameData] })
        .mockResolvedValueOnce({ rows: [{ averageRating: 4.5 }] });

      const result = await Game.findBySlug("slug-game");

      expect(mockDb.query).toHaveBeenNthCalledWith(
        1,
        'SELECT * FROM "games" WHERE "slug" = $1',
        ["slug-game"]
      );
      expect(mockDb.query).toHaveBeenNthCalledWith(
        2,
        'SELECT AVG("rating") as "averageRating" FROM "ratings" WHERE "gameId" = $1',
        [1]
      );
      expect(result).toBeInstanceOf(Game);
      expect(result?.averageRating).toBe(4.5);
    });

    it("should return null when game not found by slug", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      const result = await Game.findBySlug("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("find", () => {
    it("should find games with basic query", async () => {
      const mockGamesData = [
        {
          id: 1,
          title: "Game 1",
          slug: "game-1",
          description: "Game 1 description",
          genre: "ACTION",
          release: 1990,
          developer: "Dev 1",
          publisher: "Pub 1",
          images: [],
          stream: "",
          manual: "",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          averageRating: "4.5",
        },
        {
          id: 2,
          title: "Game 2",
          slug: "game-2",
          description: "Game 2 description",
          genre: "STRATEGY",
          release: 1995,
          developer: "Dev 2",
          publisher: "Pub 2",
          images: [],
          stream: "",
          manual: "",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          averageRating: "3.8",
        },
      ];

      (mockDb.query as any).mockResolvedValueOnce({ rows: mockGamesData });

      const result = await Game.find();

      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(Game);
      expect(result[0].averageRating).toBe(4.5);
      expect(result[1].averageRating).toBe(3.8);
    });

    it("should find games with genre filter", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ genre: "action" });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('g."genre" = $1'),
        expect.arrayContaining(["ACTION"])
      );
    });

    it("should find games with letter filter", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ letter: "A" });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('g."title" ILIKE $1'),
        expect.arrayContaining(["A%"])
      );
    });

    it("should find games with search query", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ search: "mario" });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('g."title" ILIKE $1'),
        expect.arrayContaining(["%mario%"])
      );
    });

    it("should find games with year filter", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ year: 1990 });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('g."release" = $1'),
        expect.arrayContaining([1990])
      );
    });

    it("should find games with developer filter", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ developer: "Nintendo" });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('g."developer" = $1'),
        expect.arrayContaining(["Nintendo"])
      );
    });

    it("should find games with publisher filter", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ publisher: "Sega" });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining(
          '(g."publisher" = $1 OR (g."developer" = $1 AND (g."publisher" IS NULL OR g."publisher" = \'\')))'
        ),
        expect.arrayContaining(["Sega"])
      );
    });

    it("should find games with limit and pagination", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ limit: 10, page: 2 });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT $1 OFFSET $2"),
        expect.arrayContaining([10, 10])
      );
    });

    it("should handle null averageRating in find results", async () => {
      const mockGamesData = [
        {
          id: 1,
          title: "Game with null rating",
          slug: "game-null-rating",
          description: "Game description",
          genre: "ACTION",
          release: 1990,
          developer: "Dev",
          publisher: "Pub",
          images: [],
          stream: "",
          manual: "",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          averageRating: null,
        },
      ];

      (mockDb.query as any).mockResolvedValueOnce({ rows: mockGamesData });

      const result = await Game.find();

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(Game);
      expect(result[0].averageRating).toBe(0);
    });

    it("should handle invalid averageRating string in find results", async () => {
      const mockGamesData = [
        {
          id: 1,
          title: "Game with invalid rating",
          slug: "game-invalid-rating",
          description: "Game description",
          genre: "ACTION",
          release: 1990,
          developer: "Dev",
          publisher: "Pub",
          images: [],
          stream: "",
          manual: "",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          averageRating: "not-a-number",
        },
      ];

      (mockDb.query as any).mockResolvedValueOnce({ rows: mockGamesData });

      const result = await Game.find();

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(Game);
      expect(result[0].averageRating).toBe(0);
    });
  });

  describe("findRecentlyAdded", () => {
    it("should find recently added games", async () => {
      const mockGamesData = [
        {
          id: 1,
          title: "Recent Game",
          slug: "recent-game",
          description: "Recent game description",
          genre: "ACTION",
          release: 2024,
          developer: "Recent Dev",
          publisher: "Recent Pub",
          images: [],
          stream: "",
          manual: "",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          averageRating: "4.0",
        },
      ];

      (mockDb.query as any).mockResolvedValueOnce({ rows: mockGamesData });

      const result = await Game.findRecentlyAdded();

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(Game);
      expect(result[0].title).toBe("Recent Game");
    });
  });

  describe("findForSitemap", () => {
    it("should find games with minimal data for sitemap", async () => {
      const mockSitemapData = [
        {
          slug: "game-1",
          updatedAt: new Date("2025-01-01"),
        },
        {
          slug: "game-2",
          updatedAt: new Date("2025-01-02"),
        },
      ];

      (mockDb.query as any).mockResolvedValueOnce({ rows: mockSitemapData });

      const result = await Game.findForSitemap();

      expect(mockDb.query).toHaveBeenCalledWith(
        'SELECT "slug", "updatedAt" FROM "games" ORDER BY "id"'
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        slug: "game-1",
        updatedAt: new Date("2025-01-01"),
      });
      expect(result[1]).toEqual({
        slug: "game-2",
        updatedAt: new Date("2025-01-02"),
      });
    });
  });

  describe("findTopRated", () => {
    it("should find top rated games", async () => {
      const mockGamesData = [
        {
          id: 1,
          title: "Top Game",
          slug: "top-game",
          description: "Top game description",
          genre: "RPG",
          release: 1995,
          developer: "Top Dev",
          publisher: "Top Pub",
          images: [],
          stream: "",
          manual: "",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          averageRating: "4.8",
        },
      ];

      (mockDb.query as any).mockResolvedValueOnce({ rows: mockGamesData });

      const result = await Game.findTopRated();

      expect(mockDb.query).toHaveBeenCalledWith(`
      SELECT g.*, AVG(r.rating) as "averageRating"
      FROM "games" g
      LEFT JOIN "ratings" r ON g.id = r."gameId"
      GROUP BY g.id
      ORDER BY "averageRating" DESC NULLS LAST
      LIMIT 5
    `);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(Game);
      expect(result[0].averageRating).toBe(4.8);
    });

    it("should handle null averageRating in findTopRated", async () => {
      const mockGamesData = [
        {
          id: 1,
          title: "Game with null rating",
          slug: "game-null-rating",
          description: "Game description",
          genre: "ACTION",
          release: 1990,
          developer: "Dev",
          publisher: "Pub",
          images: [],
          stream: "",
          manual: "",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          averageRating: null,
        },
      ];

      (mockDb.query as any).mockResolvedValueOnce({ rows: mockGamesData });

      const result = await Game.findTopRated();

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(Game);
      expect(result[0].averageRating).toBe(0);
    });

    it("should handle invalid averageRating string in findTopRated", async () => {
      const mockGamesData = [
        {
          id: 1,
          title: "Game with invalid rating",
          slug: "game-invalid-rating",
          description: "Game description",
          genre: "ACTION",
          release: 1990,
          developer: "Dev",
          publisher: "Pub",
          images: [],
          stream: "",
          manual: "",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          averageRating: "invalid",
        },
      ];

      (mockDb.query as any).mockResolvedValueOnce({ rows: mockGamesData });

      const result = await Game.findTopRated();

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(Game);
      expect(result[0].averageRating).toBe(0);
    });
  });

  describe("create", () => {
    it("should create a new game", async () => {
      const gameData = {
        title: "New Game",
        description: "New game description",
        genre: "PUZZLE",
        release: 2024,
        developer: "New Dev",
        publisher: "New Pub",
        images: ["new.jpg"],
        stream: "new.zip",
        manual: "new.pdf",
      };

      const mockResult = { rows: [{ id: 1 }] };
      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await Game.create(gameData);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "games"'),
        expect.arrayContaining([
          gameData.title,
          "new-game",
          gameData.description,
          gameData.genre,
          gameData.release,
          gameData.developer,
          gameData.publisher,
          gameData.images,
          gameData.stream,
          gameData.manual,
        ])
      );
      expect(result.id).toBe(1);
    });

    it("should throw error when title is missing", async () => {
      const gameData = {
        description: "Game without title",
        genre: "ACTION",
      };

      await expect(Game.create(gameData)).rejects.toThrow(
        "Title and genre are required."
      );
    });

    it("should throw error when genre is missing", async () => {
      const gameData = {
        title: "Game without genre",
        description: "Game without genre description",
      };

      await expect(Game.create(gameData)).rejects.toThrow(
        "Title and genre are required."
      );
    });

    it("should handle empty release year as null", async () => {
      const gameData = {
        title: "Game with empty release",
        genre: "ACTION",
        release: "",
      };

      const mockResult = { rows: [{ id: 1 }] };
      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      await Game.create(gameData as any);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "games"'),
        expect.arrayContaining([null])
      );
    });
  });

  describe("update", () => {
    it("should update an existing game", async () => {
      const gameData = {
        title: "Updated Game",
        description: "Updated description",
        genre: "SPORTS",
        release: 2023,
        developer: "Updated Dev",
        publisher: "Updated Pub",
        images: ["updated.jpg"],
        stream: "updated.zip",
        manual: "updated.pdf",
      };

      const mockResult = { rows: [{ id: 1 }] };
      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await Game.update(1, gameData);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE "games" SET'),
        expect.arrayContaining([
          gameData.title,
          "updated-game",
          gameData.description,
          gameData.genre,
          gameData.release,
          gameData.developer,
          gameData.publisher,
          gameData.images,
          gameData.stream,
          gameData.manual,
          expect.any(Date),
          1,
        ])
      );
      expect(result.id).toBe(1);
    });
  });

  describe("delete", () => {
    it("should delete a game", async () => {
      // Mock findById call (first query) - return empty rows (game not found)
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] }) // findById returns no game
        .mockResolvedValueOnce({}); // DELETE query

      await Game.delete(1);

      expect(mockDb.query).toHaveBeenCalledTimes(2);
      expect(mockDb.query).toHaveBeenNthCalledWith(
        1,
        'SELECT * FROM "games" WHERE "id" = $1',
        [1]
      );
      expect(mockDb.query).toHaveBeenNthCalledWith(
        2,
        'DELETE FROM "games" WHERE "id" = $1',
        [1]
      );
    });
  });

  describe("rate", () => {
    it("should add or update a rating", async () => {
      (mockDb.query as any).mockResolvedValueOnce({});

      await Game.rate(1, "192.168.1.1", 5);

      expect(mockDb.query).toHaveBeenCalledWith(
        'INSERT INTO "ratings" ("gameId", "ipAddress", "rating") VALUES ($1, $2, $3) ON CONFLICT ("gameId", "ipAddress") DO UPDATE SET "rating" = $3',
        [1, "192.168.1.1", 5]
      );
    });
  });

  describe("getAverageRating", () => {
    it("should get average rating for a game", async () => {
      const mockResult = { rows: [{ averageRating: 4.2 }] };
      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await Game.getAverageRating(1);

      expect(mockDb.query).toHaveBeenCalledWith(
        'SELECT AVG("rating") as "averageRating" FROM "ratings" WHERE "gameId" = $1',
        [1]
      );
      expect(result).toBe(4.2);
    });

    it("should return 0 when no ratings found", async () => {
      const mockResult = { rows: [{ averageRating: null }] };
      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await Game.getAverageRating(1);

      expect(result).toBe(0);
    });
  });

  describe("getDevelopers", () => {
    it("should get list of developers", async () => {
      const mockResult = {
        rows: [
          { developer: "Nintendo" },
          { developer: "Sega" },
          { developer: "Capcom" },
        ],
      };
      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await Game.getDevelopers();

      expect(mockDb.query).toHaveBeenCalledWith(
        'SELECT DISTINCT "developer" FROM "games" WHERE "developer" IS NOT NULL AND "developer" != \'\' ORDER BY "developer" ASC'
      );
      expect(result).toEqual(["Nintendo", "Sega", "Capcom"]);
    });
  });

  describe("getPublishers", () => {
    it("should get list of publishers", async () => {
      const mockResult = {
        rows: [{ name: "Nintendo" }, { name: "Sega" }, { name: "Square" }],
      };
      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await Game.getPublishers();

      expect(mockDb.query).toHaveBeenCalledWith(`
      SELECT DISTINCT name FROM (
        SELECT "publisher" as name FROM "games"
        WHERE "publisher" IS NOT NULL AND "publisher" != ''
        UNION
        SELECT "developer" as name FROM "games"
        WHERE "developer" IS NOT NULL AND "developer" != ''
        AND ("publisher" IS NULL OR "publisher" = '')
      ) AS publishers
      ORDER BY name ASC
    `);
      expect(result).toEqual(["Nintendo", "Sega", "Square"]);
    });
  });

  describe("getYears", () => {
    it("should get list of release years", async () => {
      const mockResult = {
        rows: [
          { release: 2024 },
          { release: 2023 },
          { release: 1995 },
          { release: 1990 },
        ],
      };
      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await Game.getYears();

      expect(mockDb.query).toHaveBeenCalledWith(`
      SELECT DISTINCT "release"
      FROM "games"
      WHERE "release" IS NOT NULL
      ORDER BY "release" DESC
    `);
      expect(result).toEqual([2024, 2023, 1995, 1990]);
    });
  });

  describe("findSimilar", () => {
    it("should find similar games from the same genre", async () => {
      const mockResult = {
        rows: [
          {
            id: 2,
            title: "Similar Game 1",
            slug: "similar-game-1",
            description: "Description 1",
            genre: "ACTION",
            release: 1991,
            developer: "Dev 1",
            publisher: "Pub 1",
            images: ["img1.jpg"],
            stream: "stream1.zip",
            manual: "manual1.pdf",
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            averageRating: "4.5",
          },
          {
            id: 3,
            title: "Similar Game 2",
            slug: "similar-game-2",
            description: "Description 2",
            genre: "ACTION",
            release: 1992,
            developer: "Dev 2",
            publisher: "Pub 2",
            images: ["img2.jpg"],
            stream: "stream2.zip",
            manual: "manual2.pdf",
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            averageRating: "3.8",
          },
        ],
      };
      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await Game.findSimilar(1, "ACTION", 6);

      expect(mockDb.query).toHaveBeenCalledWith(
        `
      SELECT g.*, AVG(r."rating") as "averageRating"
      FROM "games" g
      LEFT JOIN "ratings" r ON g."id" = r."gameId"
      WHERE g."genre" = $1 AND g."id" != $2
      GROUP BY g.id
      ORDER BY "averageRating" DESC NULLS LAST, g."createdAt" DESC
      LIMIT $3
    `,
        ["ACTION", 1, 6]
      );
      expect(result).toHaveLength(2);
      expect(result[0].title).toBe("Similar Game 1");
      expect(result[0].averageRating).toBe(4.5);
      expect(result[1].title).toBe("Similar Game 2");
      expect(result[1].averageRating).toBe(3.8);
    });

    it("should return empty array when no similar games found", async () => {
      const mockResult = { rows: [] };
      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await Game.findSimilar(1, "ADVENTURE", 6);

      expect(result).toHaveLength(0);
    });
  });

  describe("findFeatured", () => {
    it("should return featured games with high ratings", async () => {
      const mockGames = {
        rows: [
          {
            id: 1,
            title: "Featured Game 1",
            slug: "featured-game-1",
            description: "A featured game",
            genre: "ACTION",
            averageRating: "4.5",
          },
          {
            id: 2,
            title: "Featured Game 2",
            slug: "featured-game-2",
            description: "Another featured game",
            genre: "ADVENTURE",
            averageRating: "4.0",
          },
        ],
      };

      (mockDb.query as any).mockResolvedValueOnce(mockGames);

      const result = await Game.findFeatured(10);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("HAVING AVG(r.rating) >= 3.5"),
        [10]
      );
      expect(result).toHaveLength(2);
      expect(result[0].title).toBe("Featured Game 1");
      expect(result[0].averageRating).toBe(4.5);
    });

    it("should use default limit when not specified", async () => {
      const mockGames = { rows: [] };
      (mockDb.query as any).mockResolvedValueOnce(mockGames);

      await Game.findFeatured();

      expect(mockDb.query).toHaveBeenCalledWith(expect.any(String), [8]);
    });
  });

  describe("find with ordering", () => {
    it("should order by rating when orderBy is rating", async () => {
      const mockGames = {
        rows: [
          {
            id: 1,
            title: "Game 1",
            slug: "game-1",
            description: "Description",
            genre: "ACTION",
            averageRating: "4.5",
          },
        ],
      };

      (mockDb.query as any).mockResolvedValueOnce(mockGames);

      await Game.find({ orderBy: "rating", orderDir: "DESC" });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY "averageRating" DESC'),
        expect.any(Array)
      );
    });

    it("should order by title for letter filter", async () => {
      const mockGames = { rows: [] };
      (mockDb.query as any).mockResolvedValueOnce(mockGames);

      await Game.find({ letter: "A" });

      const call = mockDb.query.mock.calls[0];
      const query = call[0];

      expect(query).toContain('ORDER BY g."title" ASC');
    });

    it("should order by title for year filter", async () => {
      const mockGames = { rows: [] };
      (mockDb.query as any).mockResolvedValueOnce(mockGames);

      await Game.find({ year: 1990 });

      const call = mockDb.query.mock.calls[0];
      const query = call[0];

      expect(query).toContain('ORDER BY g."title" ASC');
    });

    it("should order by title for developer filter", async () => {
      const mockGames = { rows: [] };
      (mockDb.query as any).mockResolvedValueOnce(mockGames);

      await Game.find({ developer: "Test Dev" });

      const call = mockDb.query.mock.calls[0];
      const query = call[0];

      expect(query).toContain('ORDER BY g."title" ASC');
    });

    it("should order by title for publisher filter", async () => {
      const mockGames = { rows: [] };
      (mockDb.query as any).mockResolvedValueOnce(mockGames);

      await Game.find({ publisher: "Test Pub" });

      const call = mockDb.query.mock.calls[0];
      const query = call[0];

      expect(query).toContain('ORDER BY g."title" ASC');
    });
  });
});
