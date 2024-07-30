import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import homeRouter from "../../routes/home.ts";
import Game from "../../models/game.ts";
import Comment from "../../models/comment.ts";
import GameOfTheWeek from "../../models/game-of-the-week.ts";
import News from "../../models/news.ts";

vi.mock("../../models/game", () => ({
  default: {
    find: vi.fn(),
    getGenres: vi.fn(),
    getDevelopers: vi.fn(),
    getPublishers: vi.fn(),
    getYears: vi.fn(),
    findById: vi.fn(),
    findBySlug: vi.fn(),
    findSimilar: vi.fn(),
    findAdjacentGames: vi.fn(),
    findFeatured: vi.fn(),
  },
}));

vi.mock("../../models/comment", () => ({
  default: {
    findByGameId: vi.fn(),
  },
}));

vi.mock("../../models/news", () => ({
  default: {
    findRecent: vi.fn(),
  },
}));

vi.mock("../../models/game-of-the-week", () => ({
  default: {
    getCurrent: vi.fn(),
    selectNewGameOfTheWeek: vi.fn(),
  },
}));

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.render = vi.fn((view, data) => {
    res.json({ view, data });
  });
  next();
});

app.use("/", homeRouter);

describe("Home Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for News.findRecent
    vi.mocked(News.findRecent).mockResolvedValue([]);
    // Default mock for Game.findFeatured
    vi.mocked(Game.findFeatured).mockResolvedValue([]);
  });

  describe("GET /", () => {
    it("should render index page", async () => {
      const mockGames = [{ id: 1, title: "Test Game 1", genre: "ACTION" }];
      const mockNews = [{ id: 1, title: "Test News", content: "Test content" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue({ id: 1 } as any);
      vi.mocked(News.findRecent).mockResolvedValue(mockNews as any);

      const response = await request(app).get("/");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("index");
      expect(response.body.data.games).toEqual(mockGames);
    });

    it("should select new game of the week if none exists", async () => {
      const mockGames = [{ id: 1, title: "Test Game 1" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue(null);
      vi.mocked(GameOfTheWeek.selectNewGameOfTheWeek).mockResolvedValue(
        undefined as any
      );

      const response = await request(app).get("/");

      expect(GameOfTheWeek.selectNewGameOfTheWeek).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should redirect to genre page when genre query param is provided", async () => {
      const response = await request(app).get("/?genre=ACTION");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/action");
    });

    it("should handle search query parameter", async () => {
      const mockGames = [{ id: 1, title: "Test Game" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue({ id: 1 } as any);

      const response = await request(app).get("/?search=test");

      expect(Game.find).toHaveBeenCalledWith({
        search: "test",
        page: 1,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
    });

    it("should reject search query longer than 100 characters", async () => {
      const longSearch = "a".repeat(101);
      const response = await request(app).get(`/?search=${longSearch}`);

      expect(response.status).toBe(404);
    });

    it("should handle valid orderBy and orderDir parameters", async () => {
      const mockGames = [{ id: 1, title: "Test Game" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue({ id: 1 } as any);

      const response = await request(app).get("/?orderBy=rating&orderDir=DESC");

      expect(Game.find).toHaveBeenCalledWith({
        search: undefined,
        page: 1,
        limit: 25,
        orderBy: "rating",
        orderDir: "DESC",
      });
      expect(response.status).toBe(200);
    });

    it("should reject invalid orderBy parameter", async () => {
      const response = await request(app).get("/?orderBy=invalid");

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderDir parameter", async () => {
      const response = await request(app).get("/?orderDir=INVALID");

      expect(response.status).toBe(404);
    });

    it("should handle pagination", async () => {
      const mockGames = [{ id: 1, title: "Test Game" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue({ id: 1 } as any);

      const response = await request(app).get("/?page=2");

      expect(Game.find).toHaveBeenCalledWith({
        search: undefined,
        page: 2,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
    });
  });

  describe("GET /:genre", () => {
    it("should render games for valid genre", async () => {
      const mockGames = [{ id: 1, title: "Action Game", genre: "ACTION" }];

      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION", "ADVENTURE"]);
      vi.mocked(Game.find).mockResolvedValue(mockGames as any);

      const response = await request(app).get("/action");

      expect(Game.getGenres).toHaveBeenCalled();
      expect(Game.find).toHaveBeenCalledWith({
        genre: "action",
        page: 1,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("index");
      expect(response.body.data.genre).toBe("action");
    });

    it("should return 404 for invalid genre", async () => {
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION", "ADVENTURE"]);

      const response = await request(app).get("/invalid-genre");

      expect(response.status).toBe(404);
    });

    it("should handle orderBy and orderDir for genre", async () => {
      const mockGames = [{ id: 1, title: "Action Game" }];

      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
      vi.mocked(Game.find).mockResolvedValue(mockGames as any);

      const response = await request(app).get(
        "/action?orderBy=title&orderDir=ASC"
      );

      expect(Game.find).toHaveBeenCalledWith({
        genre: "action",
        page: 1,
        limit: 25,
        orderBy: "title",
        orderDir: "ASC",
      });
      expect(response.status).toBe(200);
    });

    it("should reject invalid orderBy for genre", async () => {
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);

      const response = await request(app).get("/action?orderBy=invalid");

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderDir for genre", async () => {
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);

      const response = await request(app).get("/action?orderDir=INVALID");

      expect(response.status).toBe(404);
    });
  });

  describe("GET /letter/:letter", () => {
    it("should render games for valid letter", async () => {
      const mockGames = [{ id: 1, title: "Amazing Game" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);

      const response = await request(app).get("/letter/a");

      expect(Game.find).toHaveBeenCalledWith({
        letter: "a",
        page: 1,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("index");
      expect(response.body.data.letter).toBe("a");
      expect(response.body.data.title).toContain("'A'");
      expect(response.body.data.canonicalUrl).toBe(
        "https://oldschoolgames.eu/letter/a"
      );
    });

    it("should return 404 for invalid letter", async () => {
      const response = await request(app).get("/letter/123");

      expect(response.status).toBe(404);
    });

    it("should return 404 for multiple characters", async () => {
      const response = await request(app).get("/letter/abc");

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderBy for letter", async () => {
      const response = await request(app).get("/letter/a?orderBy=invalid");

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderDir for letter", async () => {
      const response = await request(app).get("/letter/a?orderDir=INVALID");

      expect(response.status).toBe(404);
    });
  });

  describe("GET /developers", () => {
    it("should render developers page", async () => {
      const mockDevelopers = ["Sierra", "LucasArts"];

      vi.mocked(Game.getDevelopers).mockResolvedValue(mockDevelopers);

      const response = await request(app).get("/developers");

      expect(Game.getDevelopers).toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/developers");
      expect(response.body.data.developers).toEqual(mockDevelopers);
    });
  });

  describe("GET /publishers", () => {
    it("should render publishers page", async () => {
      const mockPublishers = ["Sierra", "Electronic Arts"];

      vi.mocked(Game.getPublishers).mockResolvedValue(mockPublishers);

      const response = await request(app).get("/publishers");

      expect(Game.getPublishers).toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/publishers");
      expect(response.body.data.publishers).toEqual(mockPublishers);
    });
  });

  describe("GET /developer/:developer", () => {
    it("should render games for developer", async () => {
      const mockGames = [{ id: 1, title: "Sierra Game", developer: "Sierra" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);

      const response = await request(app).get("/developer/Sierra");

      expect(Game.find).toHaveBeenCalledWith({
        developer: "Sierra",
        page: 1,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("index");
      expect(response.body.data.developer).toBe("Sierra");
    });

    it("should handle invalid orderBy for developer", async () => {
      const response = await request(app).get(
        "/developer/Sierra?orderBy=invalid"
      );

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderDir for developer", async () => {
      const response = await request(app).get(
        "/developer/Sierra?orderDir=INVALID"
      );

      expect(response.status).toBe(404);
    });
  });

  describe("GET /publisher/:publisher", () => {
    it("should render games for publisher", async () => {
      const mockGames = [
        { id: 1, title: "EA Game", publisher: "Electronic Arts" },
      ];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);

      const response = await request(app).get("/publisher/Electronic%20Arts");

      expect(Game.find).toHaveBeenCalledWith({
        publisher: "Electronic Arts",
        page: 1,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("index");
      expect(response.body.data.publisher).toBe("Electronic Arts");
    });

    it("should reject invalid orderBy for publisher", async () => {
      const response = await request(app).get(
        "/publisher/Electronic%20Arts?orderBy=invalid"
      );

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderDir for publisher", async () => {
      const response = await request(app).get(
        "/publisher/Electronic%20Arts?orderDir=INVALID"
      );

      expect(response.status).toBe(404);
    });
  });

  describe("GET /years", () => {
    it("should render years page", async () => {
      const mockYears = [1990, 1991, 1992];

      vi.mocked(Game.getYears).mockResolvedValue(mockYears);

      const response = await request(app).get("/years");

      expect(Game.getYears).toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/years");
      expect(response.body.data.years).toEqual(mockYears);
      expect(response.body.data.title).toContain("Game Years");
    });
  });

  describe("GET /year/:year", () => {
    it("should render games for valid year", async () => {
      const mockGames = [{ id: 1, title: "1990 Game", release: 1990 }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);

      const response = await request(app).get("/year/1990");

      expect(Game.find).toHaveBeenCalledWith({
        year: 1990,
        page: 1,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("index");
      expect(response.body.data.year).toBe(1990);
      expect(response.body.data.title).toContain("1990");
    });

    it("should return 404 for invalid year", async () => {
      const response = await request(app).get("/year/invalid");

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderBy for year", async () => {
      const response = await request(app).get("/year/1990?orderBy=invalid");

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderDir for year", async () => {
      const response = await request(app).get("/year/1990?orderDir=INVALID");

      expect(response.status).toBe(404);
    });
  });

  describe("GET /:id", () => {
    it("should render game detail for numeric ID", async () => {
      const mockGame = {
        id: 123,
        title: "Test Game",
        genre: "Action",
        images: ["test-image.jpg"],
      };
      const mockComments = [{ id: 1, content: "Great game!" }];
      const mockSimilarGames = [
        { id: 124, title: "Similar Game", genre: "Action" },
      ];
      const mockAdjacentGames = { prevGame: null, nextGame: null };

      vi.mocked(Game.findById).mockResolvedValue(mockGame as any);
      vi.mocked(Comment.findByGameId).mockResolvedValue(mockComments as any);
      vi.mocked(Game.findSimilar).mockResolvedValue(mockSimilarGames as any);
      vi.mocked(Game.findAdjacentGames).mockResolvedValue(mockAdjacentGames);

      const response = await request(app).get("/123");

      expect(Game.findById).toHaveBeenCalledWith("123");
      expect(Comment.findByGameId).toHaveBeenCalledWith(123);
      expect(Game.findSimilar).toHaveBeenCalledWith(123, "Action", 6);
      expect(Game.findAdjacentGames).toHaveBeenCalledWith("Test Game");
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/game-detail");
      expect(response.body.data.game).toEqual(mockGame);
      expect(response.body.data.comments).toEqual(mockComments);
      expect(response.body.data.similarGames).toEqual(mockSimilarGames);
      expect(response.body.data.title).toContain("Test Game");
    });

    it("should render game detail for slug", async () => {
      const mockGame = {
        id: 123,
        title: "Test Game",
        genre: "Adventure",
        images: ["test-image.jpg"],
      };
      const mockComments = [];
      const mockSimilarGames = [];
      const mockAdjacentGames = { prevGame: null, nextGame: null };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);
      vi.mocked(Comment.findByGameId).mockResolvedValue(mockComments as any);
      vi.mocked(Game.findSimilar).mockResolvedValue(mockSimilarGames as any);
      vi.mocked(Game.findAdjacentGames).mockResolvedValue(mockAdjacentGames);

      const response = await request(app).get("/test-game-slug");

      expect(Game.findBySlug).toHaveBeenCalledWith("test-game-slug");
      expect(Comment.findByGameId).toHaveBeenCalledWith(123);
      expect(Game.findSimilar).toHaveBeenCalledWith(123, "Adventure", 6);
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/game-detail");
    });

    it("should return 404 for non-existent game", async () => {
      vi.mocked(Game.findById).mockResolvedValue(null);

      const response = await request(app).get("/999");

      expect(response.status).toBe(404);
    });

    it("should return 404 for non-existent slug", async () => {
      vi.mocked(Game.findBySlug).mockResolvedValue(null);

      const response = await request(app).get("/non-existent-slug");

      expect(response.status).toBe(404);
    });
  });

  describe("GET /profile", () => {
    it("should render profile page", async () => {
      const response = await request(app).get("/profile");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("profile");
    });
  });

  describe("GET /:slug/gallery/:index", () => {
    it("should render game gallery for valid index", async () => {
      const mockGame = {
        id: 1,
        title: "Test Game",
        slug: "test-game",
        images: ["image1.jpg", "image2.jpg", "image3.jpg"],
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);

      const response = await request(app).get("/test-game/gallery/1");

      expect(Game.findBySlug).toHaveBeenCalledWith("test-game");
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/game-gallery");
      expect(response.body.data.currentIndex).toBe(1);
    });

    it("should return 404 for non-existent game in gallery", async () => {
      vi.mocked(Game.findBySlug).mockResolvedValue(null);

      const response = await request(app).get("/non-existent/gallery/0");

      expect(response.status).toBe(404);
    });

    it("should return 404 for invalid index", async () => {
      const mockGame = {
        id: 1,
        title: "Test Game",
        images: ["image1.jpg", "image2.jpg"],
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);

      const response = await request(app).get("/test-game/gallery/invalid");

      expect(response.status).toBe(404);
    });

    it("should return 404 for out of bounds index", async () => {
      const mockGame = {
        id: 1,
        title: "Test Game",
        images: ["image1.jpg", "image2.jpg"],
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);

      const response = await request(app).get("/test-game/gallery/10");

      expect(response.status).toBe(404);
    });

    it("should return 404 for negative index", async () => {
      const mockGame = {
        id: 1,
        title: "Test Game",
        images: ["image1.jpg", "image2.jpg"],
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);

      const response = await request(app).get("/test-game/gallery/-1");

      expect(response.status).toBe(404);
    });
  });
});
