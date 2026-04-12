import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import listsRouter, { LISTS } from "../../routes/lists.ts";
import Game from "../../models/game.ts";

vi.mock("../../models/game", () => ({
  default: {
    find: vi.fn(),
    count: vi.fn(),
  },
}));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.render = vi.fn((view, data) => {
    res.json({ view, data });
  }) as any;
  next();
});

app.use("/", listsRouter);

// Fallthrough 404 for unknown slugs
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

describe("Lists Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /game-lists", () => {
    it("should render the lists index page", async () => {
      const response = await request(app).get("/game-lists");
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("lists/lists-index");
    });

    it("should pass all LISTS to the view", async () => {
      const response = await request(app).get("/game-lists");
      expect(response.body.data.lists).toBeDefined();
      expect(response.body.data.lists.length).toBe(LISTS.length);
    });

    it("should include title, description and canonicalUrl in view data", async () => {
      const response = await request(app).get("/game-lists");
      expect(response.body.data.title).toBeDefined();
      expect(response.body.data.description).toBeDefined();
      expect(response.body.data.canonicalUrl).toBeDefined();
    });
  });

  describe("GET /:slug — known list", () => {
    const mockGames = [{ id: 1, title: "Test Game", slug: "test-game" }];

    beforeEach(() => {
      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.count).mockResolvedValue(1);
    });

    it("should render list page for a known slug", async () => {
      const response = await request(app).get("/top-dos-games");
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("lists/list");
    });

    it("should pass games and pagination data to the view", async () => {
      const response = await request(app).get("/top-dos-games");
      expect(response.body.data.games).toEqual(mockGames);
      expect(response.body.data.page).toBe(1);
      expect(response.body.data.totalCount).toBe(1);
      expect(response.body.data.totalPages).toBe(1);
    });

    it("should pass list metadata to the view", async () => {
      const response = await request(app).get("/top-dos-games");
      const { list } = response.body.data;
      expect(list).toBeDefined();
      expect(list.slug).toBe("top-dos-games");
      expect(list.h1).toBeDefined();
      expect(list.title).toBeDefined();
    });

    it("should pass relatedLists array to the view", async () => {
      const response = await request(app).get("/top-dos-games");
      expect(Array.isArray(response.body.data.relatedLists)).toBe(true);
      expect(response.body.data.relatedLists.length).toBeGreaterThan(0);
    });

    it("should use page=1 as default when no page query param", async () => {
      const response = await request(app).get("/top-dos-games");
      expect(response.body.data.page).toBe(1);
    });

    it("should respect page query parameter", async () => {
      vi.mocked(Game.count).mockResolvedValue(100);
      vi.mocked(Game.find).mockResolvedValue(
        Array(25).fill(mockGames[0]) as any,
      );

      const response = await request(app).get("/top-dos-games?page=3");
      expect(response.status).toBe(200);
      expect(response.body.data.page).toBe(3);
    });

    it("should clamp page to minimum 1 for invalid page values", async () => {
      const response = await request(app).get("/top-dos-games?page=0");
      expect(response.body.data.page).toBe(1);
    });

    it("should return canonical URL without page for page 1", async () => {
      const response = await request(app).get("/top-dos-games");
      expect(response.body.data.canonicalUrl).toBe(
        "https://oldschoolgames.eu/top-dos-games",
      );
    });

    it("should return paginated canonical URL for page > 1", async () => {
      vi.mocked(Game.count).mockResolvedValue(100);
      vi.mocked(Game.find).mockResolvedValue(
        Array(25).fill(mockGames[0]) as any,
      );

      const response = await request(app).get("/top-dos-games?page=2");
      expect(response.body.data.canonicalUrl).toBe(
        "https://oldschoolgames.eu/top-dos-games?page=2",
      );
    });

    it("should include prevPageUrl for page > 1", async () => {
      vi.mocked(Game.count).mockResolvedValue(100);
      vi.mocked(Game.find).mockResolvedValue(
        Array(25).fill(mockGames[0]) as any,
      );

      const response = await request(app).get("/top-dos-games?page=3");
      expect(response.body.data.prevPageUrl).toBe(
        "https://oldschoolgames.eu/top-dos-games?page=2",
      );
    });

    it("should use base URL as prevPageUrl for page 2 (no ?page=1)", async () => {
      vi.mocked(Game.count).mockResolvedValue(100);
      vi.mocked(Game.find).mockResolvedValue(
        Array(25).fill(mockGames[0]) as any,
      );

      const response = await request(app).get("/top-dos-games?page=2");
      expect(response.body.data.prevPageUrl).toBe(
        "https://oldschoolgames.eu/top-dos-games",
      );
    });

    it("should not include prevPageUrl on page 1", async () => {
      const response = await request(app).get("/top-dos-games");
      expect(response.body.data.prevPageUrl).toBeUndefined();
    });

    it("should include nextPageUrl when more pages exist", async () => {
      vi.mocked(Game.count).mockResolvedValue(100);
      vi.mocked(Game.find).mockResolvedValue(
        Array(25).fill(mockGames[0]) as any,
      );

      const response = await request(app).get("/top-dos-games");
      expect(response.body.data.nextPageUrl).toBe(
        "https://oldschoolgames.eu/top-dos-games?page=2",
      );
    });

    it("should not include nextPageUrl on last page", async () => {
      vi.mocked(Game.count).mockResolvedValue(1);
      vi.mocked(Game.find).mockResolvedValue(mockGames as any);

      const response = await request(app).get("/top-dos-games");
      expect(response.body.data.nextPageUrl).toBeUndefined();
    });

    it("should pass RPG genre filter for best-rpg-games list", async () => {
      const response = await request(app).get("/best-rpg-games");
      expect(response.status).toBe(200);
      expect(vi.mocked(Game.find)).toHaveBeenCalledWith(
        expect.objectContaining({ genre: "RPG" }),
      );
    });

    it("should pass PUZZLE genre filter for best-puzzle-games list", async () => {
      await request(app).get("/best-puzzle-games");
      expect(vi.mocked(Game.find)).toHaveBeenCalledWith(
        expect.objectContaining({ genre: "PUZZLE" }),
      );
    });

    it("should render all known list slugs", async () => {
      for (const list of LISTS) {
        vi.mocked(Game.find).mockResolvedValue(mockGames as any);
        vi.mocked(Game.count).mockResolvedValue(1);

        const response = await request(app).get(`/${list.slug}`);
        expect(response.status).toBe(200);
        expect(response.body.view).toBe("lists/list");
      }
    });
  });

  describe("GET /:slug — unknown slug", () => {
    it("returns 404 for an unknown slug", async () => {
      const response = await request(app).get("/nonexistent-list-slug");
      expect(response.status).toBe(404);
    });
  });
});
