import { beforeEach, describe, expect, it, vi } from "vitest";
import Game from "../../models/game.ts";
import db from "../../db.ts";
import { sidebarCache } from "../../utils/sidebar-cache.ts";

vi.mock("../../db", () => ({
  default: {
    query: vi.fn(),
  },
}));

const mockDb = vi.mocked(db);

describe("Game Model", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // findFeatured now draws from a pool held in this cache, so an entry left
    // behind by one test would answer the next one without a query.
    sidebarCache.clear();
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

  /**
   * The templates reached for images[0], which is undefined for a game with
   * no artwork — and <img src=""> makes the browser resolve the empty address
   * against the current document and fetch the whole page as if it were an
   * image. Callers test this before rendering the tag.
   */
  describe("cover", () => {
    const base = {
      id: 1,
      title: "T",
      slug: "t",
      description: "",
      genre: "ACTION",
      release: null,
      developer: "",
      publisher: "",
      stream: "",
      manual: "",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };

    it("is the first image when there is one", () => {
      const game = new Game({ ...base, images: ["a.png", "b.png"] });

      expect(game.cover).toBe("a.png");
    });

    it("is an empty string when the game has no artwork", () => {
      const game = new Game({ ...base, images: [] });

      expect(game.cover).toBe("");
    });

    // The admin form posts four image slots, so a filled second one behind an
    // empty first is an ordinary shape rather than a broken row.
    it("skips a blank leading slot rather than returning it", () => {
      const game = new Game({ ...base, images: ["", "b.png"] });

      expect(game.cover).toBe("b.png");
    });
  });

  describe("createSlug", () => {
    it("should create a slug from title", () => {
      expect(Game.createSlug("Test Game")).toBe("test-game");
      expect(Game.createSlug("Super Mario Bros.")).toBe("super-mario-bros");
      expect(Game.createSlug("Game with Special Characters!@#")).toBe(
        "game-with-special-characters",
      );
      expect(Game.createSlug("Multiple   Spaces")).toBe("multiple-spaces");
      expect(Game.createSlug("-Leading and Trailing-")).toBe(
        "leading-and-trailing",
      );
    });

    // Shared with News through utils/slug.ts, which is also where the fold
    // lives: the [a-z0-9] filter used to drop the accented letter along with
    // the accent, so "Pokémon" addressed itself as "pok-mon".
    it("folds a diacritic rather than dropping the letter", () => {
      expect(Game.createSlug("Pokémon Café")).toBe("pokemon-cafe");
      expect(Game.createSlug("Große Reise")).toBe("grosse-reise");
    });
  });

  describe("resolveSlug", () => {
    it("should use the plain slug when nothing has claimed it", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      expect(await Game.resolveSlug("Doom")).toBe("doom");
    });

    // Two games sharing a title used to collide on the UNIQUE constraint and
    // fail the save with a 500.
    it("should suffix a slug another game already holds", async () => {
      (mockDb.query as any).mockResolvedValueOnce({
        rows: [{ slug: "doom" }],
      });

      expect(await Game.resolveSlug("Doom")).toBe("doom-2");
    });

    it("should keep counting past suffixes that are taken too", async () => {
      (mockDb.query as any).mockResolvedValueOnce({
        rows: [{ slug: "doom" }, { slug: "doom-2" }, { slug: "doom-3" }],
      });

      expect(await Game.resolveSlug("Doom")).toBe("doom-4");
    });

    it("should ignore unrelated slugs that merely share the prefix", async () => {
      (mockDb.query as any).mockResolvedValueOnce({
        rows: [{ slug: "doom-eternal" }],
      });

      expect(await Game.resolveSlug("Doom")).toBe("doom");
    });

    it("should exclude a game's own history so a rename can be undone", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.resolveSlug("Doom", 42);

      expect(mockDb.query).toHaveBeenCalledWith(expect.any(String), [
        "doom",
        "doom-%",
        42,
      ]);
    });

    it("should fall back to a usable slug for an unsluggable title", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      expect(await Game.resolveSlug("!!!")).toBe("game");
    });
  });

  describe("findCurrentSlug", () => {
    it("should return where a renamed game lives now", async () => {
      (mockDb.query as any).mockResolvedValueOnce({
        rows: [{ slug: "doom-ii" }],
      });

      expect(await Game.findCurrentSlug("doom-2")).toBe("doom-ii");
    });

    it("should return null for a slug nothing ever used", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      expect(await Game.findCurrentSlug("never-existed")).toBeNull();
    });
  });

  describe("getGenres", () => {
    /**
     * One label per row, not one array literal to take apart by hand.
     * enum_range comes back as the text "{ACTION,RPG,...}", and trimming the
     * braces and splitting on commas is not a parser — a label containing a
     * comma, a space or a quote is quoted in that literal and would have
     * arrived split down the middle with the quotes still on it.
     */
    it("should fetch genres from database", async () => {
      (mockDb.query as any).mockResolvedValueOnce({
        rows: [{ genre: "ACTION" }, { genre: "STRATEGY" }, { genre: "RPG" }],
      });

      const genres = await Game.getGenres();

      expect(mockDb.query).toHaveBeenCalledWith(
        "SELECT unnest(enum_range(NULL::GAME_GENRE))::text AS genre",
      );
      expect(genres).toEqual(["ACTION", "STRATEGY", "RPG"]);
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

      (mockDb.query as any).mockResolvedValueOnce({
        rows: [{ ...mockGameData, averageRating: "0", ratingCount: "0" }],
      });

      const result = await Game.findById(1);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE g."id" = $1'),
        [1],
      );
      expect(result).toBeInstanceOf(Game);
      expect(result?.title).toBe("Found Game");
    });

    it("should return null when game not found", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      const result = await Game.findById(999);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE g."id" = $1'),
        [999],
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

      (mockDb.query as any).mockResolvedValueOnce({
        rows: [{ ...mockGameData, averageRating: "4.5", ratingCount: "1" }],
      });

      const result = await Game.findBySlug("slug-game");

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE g."slug" = $1'),
        ["slug-game"],
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
        expect.arrayContaining(["ACTION"]),
      );
    });

    it("should find games with letter filter", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ letter: "A" });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('g."title" ILIKE $1'),
        expect.arrayContaining(["A%"]),
      );
    });

    // The routes only pass a single letter, but a model that builds an ILIKE
    // pattern out of its argument cannot rely on that: "%" matched the whole
    // catalogue and "_" any first character.
    it("escapes LIKE wildcards in the letter filter", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ letter: "%" });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["\\%%"]),
      );
    });

    it("escapes LIKE wildcards in the letter filter for count too", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [{ total: "0" }] });

      await Game.count({ letter: "_" });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["\\_%"]),
      );
    });

    it("should find games with search query", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ search: "mario" });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('g."title" ILIKE $1'),
        expect.arrayContaining(["%mario%"]),
      );
    });

    it("should find games with year filter", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ year: 1990 });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('g."release" = $1'),
        expect.arrayContaining([1990]),
      );
    });

    it("should find games with developer filter", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ developer: "Nintendo" });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('g."developer" = $1'),
        expect.arrayContaining(["Nintendo"]),
      );
    });

    it("should find games with publisher filter", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ publisher: "Sega" });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining(
          '(g."publisher" = $1 OR (g."developer" = $1 AND (g."publisher" IS NULL OR g."publisher" = \'\')))',
        ),
        expect.arrayContaining(["Sega"]),
      );
    });

    it("should find games with limit and pagination", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ limit: 10, page: 2 });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT $1 OFFSET $2"),
        expect.arrayContaining([10, 10]),
      );
    });

    it("should clamp negative pagination before creating an offset", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ limit: 10, page: -2 });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT $1 OFFSET $2"),
        expect.arrayContaining([10, 0]),
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
          images: ["https://media.example/game-1.png"],
        },
        {
          slug: "game-2",
          updatedAt: new Date("2025-01-02"),
          images: [],
        },
      ];

      (mockDb.query as any).mockResolvedValueOnce({ rows: mockSitemapData });

      const result = await Game.findForSitemap();

      // "images" is in the select for the image sitemap routes/sitemap.ts
      // builds — the artwork is a page's own content and none of it was being
      // submitted anywhere.
      expect(mockDb.query).toHaveBeenCalledWith(
        'SELECT "slug", "updatedAt", "images" FROM "games" ORDER BY "id"',
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        slug: "game-1",
        updatedAt: new Date("2025-01-01"),
        images: ["https://media.example/game-1.png"],
      });
      expect(result[1]).toEqual({
        slug: "game-2",
        updatedAt: new Date("2025-01-02"),
        images: [],
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
          ratingCount: "12",
        },
      ];

      (mockDb.query as any).mockResolvedValueOnce({ rows: mockGamesData });

      const result = await Game.findTopRated();

      const [sql, values] = (mockDb.query as any).mock.calls[0];

      // Weighted towards the site mean, so a single five-star vote cannot
      // outrank a hundred votes averaging 4.9 — and inner-joined, so a game
      // with no votes at all cannot sit in a list titled "top rated".
      expect(sql).toContain('"siteMean"');
      expect(sql).not.toContain("LEFT JOIN");
      expect(values).toEqual([5]);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(Game);
      expect(result[0].averageRating).toBe(4.8);
      // Returned now, so the sidebar can say how many votes back the average.
      expect(result[0].ratingCount).toBe(12);
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
      // First query is the slug-history lookup, then the insert itself.
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce(mockResult);

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
        ]),
      );
      expect(result.id).toBe(1);
    });

    it("should throw error when title is missing", async () => {
      const gameData = {
        description: "Game without title",
        genre: "ACTION",
      };

      await expect(Game.create(gameData)).rejects.toThrow(
        "Title and genre are required.",
      );
    });

    it("should throw error when genre is missing", async () => {
      const gameData = {
        title: "Game without genre",
        description: "Game without genre description",
      };

      await expect(Game.create(gameData)).rejects.toThrow(
        "Title and genre are required.",
      );
    });

    it("should handle empty release year as null", async () => {
      const gameData = {
        title: "Game with empty release",
        genre: "ACTION",
        release: "",
      };

      const mockResult = { rows: [{ id: 1 }] };
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce(mockResult);

      await Game.create(gameData as any);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "games"'),
        expect.arrayContaining([null]),
      );
    });

    it("should sanitize unsafe HTML in descriptions", async () => {
      const gameData = {
        title: "Unsafe Game",
        description:
          '<p>Safe</p><img src="x" onerror="alert(1)"><script>alert(2)</script>',
        genre: "ACTION",
      };

      const mockResult = { rows: [{ id: 1 }] };
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce(mockResult);

      await Game.create(gameData);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "games"'),
        expect.arrayContaining(['<p>Safe</p><img src="x">']),
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
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] }) // the game's current slug
        .mockResolvedValueOnce({ rows: [] }) // slugs already taken
        .mockResolvedValueOnce(mockResult);

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
          1,
        ]),
      );
      // Stamped on the database's clock, as News.update does, so the
      // sitemap's <lastmod> cannot run ahead of or behind "createdAt".
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('"updatedAt" = NOW()'),
        expect.anything(),
      );
      expect(result?.id).toBe(1);
    });
  });

  describe("delete", () => {
    // The route flashes "Game deleted successfully" off the back of this, so
    // the signature has to distinguish a real deletion from a no-op; it used
    // to promise nothing either way.
    it("reports whether a row was actually removed", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rowCount: 1 });
      expect(await Game.delete(1)).toBe(true);

      (mockDb.query as any).mockResolvedValueOnce({ rowCount: 0 });
      expect(await Game.delete(999)).toBe(false);
    });

    // pg leaves rowCount null for statements that report no count; that is
    // not a deletion either.
    it("treats a missing rowCount as nothing deleted", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rowCount: null });
      expect(await Game.delete(1)).toBe(false);
    });

    it("should delete a game", async () => {
      (mockDb.query as any).mockResolvedValueOnce({});

      await Game.delete(1);

      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(mockDb.query).toHaveBeenCalledWith(
        'DELETE FROM "games" WHERE "id" = $1',
        [1],
      );
    });
  });

  describe("rate", () => {
    it("should add or update a rating", async () => {
      (mockDb.query as any).mockResolvedValueOnce({});

      await Game.rate(1, "voter-abc", 5, "192.168.1.1");

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT ("gameId", "voterId")'),
        [1, "voter-abc", "192.168.1.1", 5],
      );
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
        'SELECT DISTINCT "developer" FROM "games" WHERE "developer" IS NOT NULL AND "developer" != \'\' ORDER BY "developer" ASC',
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
        expect.stringContaining('WHERE g."genre" = $1 AND g."id" != $2'),
        ["ACTION", 1, 6],
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
    /** A pool of well-rated games, as the cached query would return it. */
    const poolRows = (count: number) => ({
      rows: Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        title: `Featured Game ${index + 1}`,
        slug: `featured-game-${index + 1}`,
        description: "A featured game",
        genre: "ACTION",
        averageRating: "4.5",
        ratingCount: "10",
      })),
    });

    it("draws well-rated games, asking for a pool rather than the limit", async () => {
      (mockDb.query as any).mockResolvedValueOnce(poolRows(40));

      const result = await Game.findFeatured(10);

      // The bar is the weighted rating, as on every other rating-ordered
      // listing: a plain average let one five-star vote feature a game.
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringMatching(/HAVING \(COUNT\(r\."rating"\) \* AVG\(r\."rating"\) \+ \$2 \* m\."value"\)\s+\/ \(COUNT\(r\."rating"\) \+ \$2\) >= 3\.5/),
        [40, 5],
      );
      expect(result).toHaveLength(10);
      expect(result.every((game) => game instanceof Game)).toBe(true);
      expect(result[0]!.averageRating).toBe(4.5);
      expect(result[0]!.ratingCount).toBe(10);
    });

    it("should use default limit when not specified", async () => {
      (mockDb.query as any).mockResolvedValueOnce(poolRows(40));

      expect(await Game.findFeatured()).toHaveLength(8);
    });

    /**
     * An unrated game joins to a single NULL row, so AVG(r.rating) is NULL
     * and the HAVING above discarded it either way — the LEFT JOIN this used
     * to carry was doing no work while saying the opposite of what the query
     * means. Asserted because the two are only equivalent as long as the
     * HAVING stays: relax it and the outer join would quietly let every
     * unrated game into the carousel.
     */
    it("requires ratings to exist rather than leaning on a NULL average", async () => {
      (mockDb.query as any).mockResolvedValueOnce(poolRows(40));

      await Game.findFeatured(10);

      const sql = (mockDb.query as any).mock.calls[0][0] as string;

      expect(sql).toContain('JOIN "ratings" r');
      expect(sql).not.toContain('LEFT JOIN "ratings" r');
    });

    // The reason the pool exists: this query groups and randomly sorts the
    // whole catalogue, and it used to run on every single homepage view.
    it("holds the pool, so a second call costs no query", async () => {
      (mockDb.query as any).mockResolvedValueOnce(poolRows(40));

      await Game.findFeatured(10);
      await Game.findFeatured(10);

      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it("still varies the draw between requests sharing one pool", async () => {
      (mockDb.query as any).mockResolvedValueOnce(poolRows(40));

      const first = (await Game.findFeatured(10)).map((game) => game.id);
      const second = (await Game.findFeatured(10)).map((game) => game.id);

      expect(mockDb.query).toHaveBeenCalledTimes(1);
      // Ten drawn from forty, twice. Identical draws are possible but
      // vanishingly unlikely; an unshuffled pool would match every time.
      expect(first).not.toEqual(second);
    });

    it("goes straight to the database when asked for more than the pool holds", async () => {
      (mockDb.query as any).mockResolvedValueOnce(poolRows(50));

      const result = await Game.findFeatured(50);

      expect(mockDb.query).toHaveBeenCalledWith(expect.any(String), [50, 5]);
      expect(result).toHaveLength(50);
    });

    // Otherwise a newly added game waited out the TTL before it could appear.
    it("drops the pool when a game is written", async () => {
      (mockDb.query as any).mockResolvedValue(poolRows(40));

      await Game.findFeatured(10);
      const callsBefore = (mockDb.query as any).mock.calls.length;

      // The delete has to report a row, because a delete that matched nothing
      // now invalidates nothing — see Game.delete. Without this the statement
      // below reads as a no-op and the pool is deliberately left alone, which
      // is a different behaviour from the one this test is about.
      (mockDb.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await Game.delete(1);
      await Game.findFeatured(10);

      // The delete's own statement, the cache-epoch bump that tells the other
      // machines about it, and a fresh pool load. With the pool left in place
      // the second findFeatured would have added nothing.
      expect((mockDb.query as any).mock.calls.length).toBe(callsBefore + 3);
    });
  });

  describe("prunePlays", () => {
    // "plays" is one row per game started and nothing used to remove them,
    // while findMostPlayed aggregates the whole table.
    it("deletes play records past the retention window", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [], rowCount: 7 });

      expect(await Game.prunePlays()).toBe(7);

      const [sql, values] = (mockDb.query as any).mock.calls[0];

      expect(sql).toContain('DELETE FROM "plays"');
      expect(sql).toContain('"createdAt" <');
      expect(values).toEqual([365]);
    });

    it("takes a retention window of its own", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await Game.prunePlays(30);

      expect(mockDb.query).toHaveBeenCalledWith(expect.any(String), [30]);
    });

    it("reports nothing removed when the driver gives no count", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [], rowCount: null });

      expect(await Game.prunePlays()).toBe(0);
    });
  });

  describe("pruneRatingIps", () => {
    // The one column in this schema that is personal data was the one thing
    // nothing ever aged out — see migrations/0031_ratings_ip_retention.sql.
    it("clears the address off votes past the retention window", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [], rowCount: 4 });

      expect(await Game.pruneRatingIps()).toBe(4);

      const [sql, values] = (mockDb.query as any).mock.calls[0];

      expect(sql).toContain('UPDATE "ratings"');
      expect(sql).toContain('"ipAddress" = NULL');
      expect(sql).toContain('"createdAt" <');
      expect(values).toEqual([90]);
    });

    // The averages every listing sorts on are built from these rows, so
    // deleting them rather than the address would rewrite the site's ratings.
    it("keeps the vote itself, deleting nothing", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await Game.pruneRatingIps();

      const [sql] = (mockDb.query as any).mock.calls[0];

      expect(sql).not.toContain("DELETE");
    });

    // Rows already scrubbed must not be rewritten on every daily pass: the
    // partial index backing this covers only those that still carry one.
    it("touches only rows that still hold an address", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await Game.pruneRatingIps();

      const [sql] = (mockDb.query as any).mock.calls[0];

      expect(sql).toContain('"ipAddress" IS NOT NULL');
    });

    it("takes a retention window of its own", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await Game.pruneRatingIps(30);

      expect(mockDb.query).toHaveBeenCalledWith(expect.any(String), [30]);
    });

    it("reports nothing scrubbed when the driver gives no count", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [], rowCount: null });

      expect(await Game.pruneRatingIps()).toBe(0);
    });
  });

  describe("find with ordering", () => {
    it("weighs the rating it orders by against the site mean", async () => {
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

      const query = mockDb.query.mock.calls[0]![0] as string;

      // The plain average is still selected, because the views print it. What
      // changed is that the ranking no longer sorts on it: this used to be
      // `ORDER BY "averageRating" DESC`, under which one five-star vote
      // outranked two hundred votes averaging 4.9 — the very thing
      // findTopRated already weighted away for the sidebar widget, leaving
      // /top-dos-games disagreeing with the widget printed beside it.
      expect(query).toContain('WITH "siteMean"');
      expect(query).toContain('CROSS JOIN "siteMean"');
      expect(query).toContain('GROUP BY g.id, "siteMean"."value"');
      expect(query).toMatch(
        /ORDER BY CASE[\s\S]*"siteMean"\."value"[\s\S]*END DESC/,
      );
      expect(query).not.toMatch(/ORDER BY "averageRating"/);
    });

    it("leaves the site mean out of an ordering that never reads it", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      // One aggregate over every rating on the site is not worth running for
      // a listing sorted alphabetically.
      await Game.find({ letter: "A" });

      expect(mockDb.query.mock.calls[0]![0] as string).not.toContain(
        '"siteMean"',
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

  describe("findAdjacentGames", () => {
    // The filter compares LOWER("title") and the sort used to order by the
    // raw "title". Under the "C" collation every uppercase letter sorts before
    // every lowercase one, so the two disagreed and the neighbour of "Doom"
    // came back as "alpha" rather than "Civilization".
    it("orders on the same expression it filters on", async () => {
      (mockDb.query as any).mockResolvedValue({ rows: [] });

      await Game.findAdjacentGames("Doom", 7);

      const [prevSql] = (mockDb.query as any).mock.calls[0];
      const [nextSql] = (mockDb.query as any).mock.calls[1];

      expect(prevSql).toContain('WHERE LOWER("title") < LOWER($1)');
      expect(prevSql).toContain('ORDER BY LOWER("title") DESC');
      expect(nextSql).toContain('WHERE LOWER("title") > LOWER($1)');
      expect(nextSql).toContain('ORDER BY LOWER("title") ASC');
    });

    // Two games sharing a title would otherwise resolve to whichever row the
    // scan happened to reach first.
    it("breaks ties on id, so the neighbour is stable", async () => {
      (mockDb.query as any).mockResolvedValue({ rows: [] });

      await Game.findAdjacentGames("Doom", 7);

      const [prevSql] = (mockDb.query as any).mock.calls[0];

      expect(prevSql).toContain('"id" DESC');
    });

    // A strict comparison on the title alone excluded every game with the
    // same title, so two games called the same thing were never each other's
    // neighbour. The id decides between them instead.
    it("includes same-title games, ordered by id", async () => {
      (mockDb.query as any).mockResolvedValue({ rows: [] });

      await Game.findAdjacentGames("Doom", 7);

      const [prevSql, prevValues] = (mockDb.query as any).mock.calls[0];
      const [nextSql, nextValues] = (mockDb.query as any).mock.calls[1];

      expect(prevSql).toContain('(LOWER("title") = LOWER($1) AND "id" < $2)');
      expect(nextSql).toContain('(LOWER("title") = LOWER($1) AND "id" > $2)');
      expect(prevValues).toEqual(["Doom", 7]);
      expect(nextValues).toEqual(["Doom", 7]);
    });

    it("returns both neighbours as games, and null where there is none", async () => {
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [{ id: 1, title: "Civilization" }] })
        .mockResolvedValueOnce({ rows: [] });

      const { prevGame, nextGame } = await Game.findAdjacentGames("Doom", 7);

      expect(prevGame).toBeInstanceOf(Game);
      expect(prevGame!.title).toBe("Civilization");
      expect(nextGame).toBeNull();
    });
  });

  describe("recordPlay", () => {
    it("should insert a play record for a given game id", async () => {
      (mockDb.query as any).mockResolvedValueOnce({});

      await Game.recordPlay(42);

      expect(mockDb.query).toHaveBeenCalledWith(
        'INSERT INTO "plays" ("gameId") VALUES ($1)',
        [42],
      );
    });

    // There is no "accepts a string id" case any more, and its absence is the
    // point: this and the other id-taking methods are typed `number`, so a
    // caller handing over a raw req.params value fails to compile rather than
    // reaching an integer column as a string. What that used to cost is in
    // utils/ids.ts. requireGameId in routes/games.ts is what parses, and
    // tests/routes/games.test.ts covers the 400 it answers.
  });

  describe("findMostPlayed", () => {
    it("should return games ordered by play count", async () => {
      const mockRows = [
        {
          id: 1,
          title: "Popular Game",
          slug: "popular-game",
          description: "Very popular",
          genre: "ACTION",
          release: 1993,
          developer: "Dev",
          publisher: "Pub",
          images: [],
          stream: "",
          manual: "",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          averageRating: "4.2",
          playCount: "15",
        },
        {
          id: 2,
          title: "Less Popular Game",
          slug: "less-popular-game",
          description: "Less popular",
          genre: "STRATEGY",
          release: 1995,
          developer: "Dev2",
          publisher: "Pub2",
          images: [],
          stream: "",
          manual: "",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          averageRating: "3.0",
          playCount: "5",
        },
      ];
      (mockDb.query as any).mockResolvedValueOnce({ rows: mockRows });

      const result = await Game.findMostPlayed(5);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY p."playCount" DESC'),
        [5],
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(Game);
      expect(result[0].title).toBe("Popular Game");
      expect(result[0].playCount).toBe(15);
      expect(result[0].averageRating).toBe(4.2);
      expect(result[1].playCount).toBe(5);
    });

    /**
     * Plays and ratings joined straight onto "games" multiplied out — every
     * play against every rating of the same game — and COUNT(DISTINCT …)
     * then counted its way back out of plays × ratings rows. Each side is
     * aggregated on its own first, so the game meets one row per side.
     */
    it("aggregates plays and ratings before joining them", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.findMostPlayed(5);

      const sql = (mockDb.query as any).mock.calls[0][0] as string;

      expect(sql).toMatch(
        /INNER JOIN \(\s*SELECT "gameId", COUNT\(\*\) as "playCount"\s+FROM "plays"\s+GROUP BY "gameId"\s*\) p/,
      );
      expect(sql).toMatch(
        /LEFT JOIN \(\s*SELECT "gameId", AVG\("rating"\) as "averageRating",\s+COUNT\(\*\) as "ratingCount"\s+FROM "ratings"\s+GROUP BY "gameId"\s*\) r/,
      );
      expect(sql).not.toContain("DISTINCT");
    });

    it("should use default limit of 5", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.findMostPlayed();

      expect(mockDb.query).toHaveBeenCalledWith(expect.any(String), [5]);
    });

    it("should handle zero play count", async () => {
      const mockRows = [
        {
          id: 1,
          title: "Unplayed Game",
          slug: "unplayed-game",
          description: "Never played",
          genre: "PUZZLE",
          release: 1992,
          developer: "Dev",
          publisher: "Pub",
          images: [],
          stream: "",
          manual: "",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          averageRating: null,
          playCount: "0",
        },
      ];
      (mockDb.query as any).mockResolvedValueOnce({ rows: mockRows });

      const result = await Game.findMostPlayed();

      expect(result[0].playCount).toBe(0);
      expect(result[0].averageRating).toBe(0);
    });
  });

  describe("find — search", () => {
    it("matches the title, developer and publisher", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ search: "lucasarts" });

      const [sql, values] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('g."title" ILIKE $1');
      expect(sql).toContain('g."developer" ILIKE $1');
      expect(sql).toContain('g."publisher" ILIKE $1');
      expect(values).toContain("%lucasarts%");
    });

    it("falls back to a fuzzy title match so typos still find games", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ search: "moneky island" });

      const [sql, values] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('similarity(g."title", $2)');
      expect(values).toContain("moneky island");
    });

    it("ranks results by relevance when no explicit sort is given", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ search: "doom" });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain("ORDER BY CASE");
      expect(sql).toContain('LOWER(g."title") = LOWER($2)');
    });

    it("respects an explicit sort over relevance", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ search: "doom", orderBy: "title", orderDir: "ASC" });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('ORDER BY g."title" ASC');
      expect(sql).not.toContain("ORDER BY CASE");
    });

    it("ignores a whitespace-only search", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ search: "   " });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).not.toContain("similarity");
    });

    // "100%" used to reach ILIKE as "%100%%", where the trailing wildcard made
    // it behave like a search for "100"; a lone "_" matched every title there is.
    it("treats wildcards in the query as literal characters", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ search: "100%" });

      const [, values] = (mockDb.query as any).mock.calls[0];
      expect(values).toContain("%100\\%%");
    });

    it("escapes underscores and backslashes too", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ search: "a_b\\c" });

      const [, values] = (mockDb.query as any).mock.calls[0];
      expect(values).toContain("%a\\_b\\\\c%");
    });

    // similarity() and the exact-title comparison read their argument as text,
    // not as a pattern, so they still get the term as typed.
    it("keeps the raw term for the fuzzy and exact matches", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.find({ search: "100%" });

      const [sql, values] = (mockDb.query as any).mock.calls[0];
      expect(values).toContain("100%");
      expect(sql).toContain('similarity(g."title", $2)');
      // The prefix match is a pattern, so it uses the escaped copy.
      expect(sql).toContain('g."title" ILIKE $3');
    });
  });

  describe("findByIds", () => {
    it("looks up the given ids", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.findByIds(["3", "7"]);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('g."id" = ANY($1)'),
        [[3, 7]],
      );
    });

    it("drops values that are not positive integers", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.findByIds(["3", "abc", "-1", "0"]);

      expect(mockDb.query).toHaveBeenCalledWith(expect.any(String), [[3]]);
    });

    it("skips the query entirely when nothing valid is left", async () => {
      const result = await Game.findByIds(["abc"]);

      expect(result).toEqual([]);
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it("caps the number of ids it will look up", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.findByIds(Array.from({ length: 150 }, (_, i) => i + 1));

      expect((mockDb.query as any).mock.calls[0][1][0]).toHaveLength(100);
    });
  });

  describe("findRandom", () => {
    it("only picks a game that can actually be played", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.findRandom();

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain(`g."stream" IS NOT NULL AND g."stream" <> ''`);
      expect(sql).toContain("ORDER BY RANDOM()");
    });

    it("can exclude the game the visitor is already on", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.findRandom(42);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining(`g."id" <> $1`),
        [42],
      );
    });

    it("returns null when there is nothing to pick", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      expect(await Game.findRandom()).toBeNull();
    });

    /**
     * "?not=" only ever says which game to skip, so anything unusable is
     * simply no exclusion. The id lands in an integer comparison, so a value
     * Postgres cannot cast comes back as "invalid input syntax for type
     * integer" — a 500 for a malformed query parameter. The one caller parses
     * it first today; a model that builds a query out of its argument cannot
     * depend on that.
     */
    it.each([
      ["a non-numeric value", "abc"],
      ["a numeric prefix", "5abc"],
      ["a value past what an integer column holds", "99999999999999"],
      ["zero", "0"],
      ["a negative value", "-1"],
      ["an empty string", ""],
    ])("ignores %s rather than passing it to Postgres", async (_label, id) => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.findRandom(id);

      const [sql, values] = (mockDb.query as any).mock.calls[0];
      expect(sql).not.toContain(`g."id" <> $1`);
      expect(values).toEqual([]);
    });

    it("still excludes an id that arrives as a numeric string", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.findRandom("42");

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining(`g."id" <> $1`),
        [42],
      );
    });
  });

  describe("getVoterRatings", () => {
    it("maps game ids to the rating this visitor gave", async () => {
      (mockDb.query as any).mockResolvedValueOnce({
        rows: [
          { gameId: 1, rating: 5 },
          { gameId: 2, rating: 3 },
        ],
      });

      expect(await Game.getVoterRatings("voter-1")).toEqual({ 1: 5, 2: 3 });
    });

    // The cap used to have no ordering, so Postgres was free to return a
    // different 1000 rows each time: a voter past the cap saw their own stars
    // lit on one page load and dark on the next.
    it("orders the capped result, so the rows kept are the newest", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await Game.getVoterRatings("voter-1");

      const [sql] = (mockDb.query as any).mock.calls[0];

      expect(sql).toContain('ORDER BY "id" DESC');
      expect(sql).toContain("LIMIT 1000");
    });
  });

  describe("getRatingSummary", () => {
    it("returns the average and the number of votes", async () => {
      (mockDb.query as any).mockResolvedValueOnce({
        rows: [{ averageRating: "4.5", ratingCount: "8" }],
      });

      expect(await Game.getRatingSummary(1)).toEqual({
        averageRating: 4.5,
        ratingCount: 8,
      });
    });
  });

  describe("partial updates", () => {
    // Copying every known property regardless of what was sent turned a
    // partial update into a wipe of everything it did not mention.
    it("should write only the fields the caller sent", async () => {
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] }) // the game's current slug
        .mockResolvedValueOnce({ rows: [] }) // slugs already taken
        .mockResolvedValueOnce({ rows: [{ id: 1 }] });

      await Game.update(1, { title: "Renamed", genre: "ACTION" });

      const [sql, values] = (mockDb.query as any).mock.calls[2];

      expect(sql).toContain('"title" = $1');
      expect(sql).not.toContain('"description"');
      expect(sql).not.toContain('"images"');
      expect(sql).not.toContain('"stream"');
      // title, genre, slug, id — "updatedAt" is NOW() in the SQL, not a value
      expect(sql).toContain('"updatedAt" = NOW()');
      expect(values).toHaveLength(4);
    });

    it("should record the new slug in the history alongside the update", async () => {
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] }) // the game's current slug
        .mockResolvedValueOnce({ rows: [] }) // slugs already taken
        .mockResolvedValueOnce({ rows: [{ id: 1 }] });

      await Game.update(1, { title: "Renamed", genre: "ACTION" });

      // The last *write*: the cache-epoch bump that follows a save is its own
      // statement, and not the one this test is about.
      const writes = (mockDb.query as any).mock.calls.filter(([sql]: [string]) =>
        sql.includes('UPDATE "games"'),
      );

      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toContain('INSERT INTO "game_slugs"');
    });

    it("should record the slug in the history when a game is created", async () => {
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 1 }] });

      await Game.create({ title: "Brand New", genre: "ACTION" });

      const writes = (mockDb.query as any).mock.calls.filter(([sql]: [string]) =>
        sql.includes('INSERT INTO "games"'),
      );

      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toContain('INSERT INTO "game_slugs"');
    });
  });
});
