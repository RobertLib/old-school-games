import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import gamesRouter from "../../routes/games.ts";
import Game from "../../models/game.ts";

vi.mock("../../middlewares/is-auth", () => ({
  default: (req: any, res: any, next: any) => {
    try {
      if (req.session?.user) {
        next();
      } else {
        res.redirect("/login");
      }
    } catch (error) {
      next(error);
    }
  },
}));

vi.mock("../../middlewares/is-admin", () => ({
  default: (req: any, res: any, next: any) => {
    try {
      if (req.session?.user?.role === "ADMIN") {
        next();
      } else {
        res.status(403).send("Not authorized");
      }
    } catch (error) {
      next(error);
    }
  },
}));

vi.mock("../../models/game", () => ({
  default: {
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    rate: vi.fn(),
    getAverageRating: vi.fn(),
  },
}));

vi.mock("../../validations/games", () => ({
  validateGameRating: (req: any, res: any, next: any) => {
    try {
      const { id } = req.params;
      const { rating } = req.body;

      const gameId = parseInt(id, 10);
      if (isNaN(gameId) || gameId <= 0) {
        return res.status(400).json({ error: "Invalid game ID" });
      }

      const numericRating = parseInt(rating, 10);
      if (!numericRating || numericRating < 1 || numericRating > 5) {
        return res
          .status(400)
          .json({ error: "Rating must be between 1 and 5" });
      }

      next();
    } catch (error) {
      next(error);
    }
  },
}));

vi.mock("express-rate-limit", () => ({
  default: () => (req: any, res: any, next: any) => {
    try {
      next();
    } catch (error) {
      next(error);
    }
  },
}));

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const sessionHeader = req.headers.testsession;
  if (sessionHeader && typeof sessionHeader === "string") {
    try {
      const sessionData = JSON.parse(sessionHeader);
      req.session = {
        ...sessionData,
        id: "test-session-id",
        cookie: {} as any,
        regenerate: vi.fn(),
        destroy: vi.fn(),
        reload: vi.fn(),
        save: vi.fn(),
        touch: vi.fn(),
      } as any;
    } catch {
      req.session = {
        id: "test-session-id",
        cookie: {} as any,
        regenerate: vi.fn(),
        destroy: vi.fn(),
        reload: vi.fn(),
        save: vi.fn(),
        touch: vi.fn(),
      } as any;
    }
  } else {
    req.session = {
      id: "test-session-id",
      cookie: {} as any,
      regenerate: vi.fn(),
      destroy: vi.fn(),
      reload: vi.fn(),
      save: vi.fn(),
      touch: vi.fn(),
    } as any;
  }
  next();
});

app.use((req, res, next) => {
  req.flash = vi.fn((type: string, message: string) => {
    (req as any).flashMessages = (req as any).flashMessages || {};
    if (!(req as any).flashMessages[type]) {
      (req as any).flashMessages[type] = [];
    }
    (req as any).flashMessages[type].push(message);
  }) as any;
  next();
});

app.use((req, res, next) => {
  res.render = vi.fn((view, data) => {
    res.json({ view, data });
  });
  next();
});

app.use((req, res, next) => {
  Object.defineProperty(req, "ip", {
    value: "127.0.0.1",
    writable: true,
    configurable: true,
  });
  next();
});

app.use((err: any, req: any, res: any, next: any) => {
  console.error("Error in test:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.use("/games", gamesRouter);

describe("Games Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /games/new", () => {
    it("should render new game page for authenticated admin", async () => {
      const response = await request(app)
        .get("/games/new")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/new-game");
      expect(response.body.data.game).toBeNull();
    });

    it("should redirect to login for unauthenticated user", async () => {
      const response = await request(app).get("/games/new");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/login");
    });

    it("should return 403 for non-admin user", async () => {
      const response = await request(app)
        .get("/games/new")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "user@test.com", role: "USER" },
          })
        );

      expect(response.status).toBe(403);
      expect(response.text).toBe("Not authorized");
    });
  });

  describe("POST /games", () => {
    const mockGame = { id: 1 };

    beforeEach(() => {
      vi.mocked(Game.create).mockResolvedValue(mockGame as any);
    });

    it("should create game successfully for authenticated admin", async () => {
      const gameData = {
        title: "Test Game",
        description: "Test Description",
        genre: "ACTION",
        developer: "Test Developer",
      };

      const response = await request(app)
        .post("/games")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        )
        .send(gameData);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
      expect(Game.create).toHaveBeenCalledWith(gameData);
    });

    it("should redirect to login for unauthenticated user", async () => {
      const response = await request(app)
        .post("/games")
        .send({ title: "Test Game" });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/login");
    });

    it("should return 403 for non-admin user", async () => {
      const response = await request(app)
        .post("/games")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "user@test.com", role: "USER" },
          })
        )
        .send({ title: "Test Game" });

      expect(response.status).toBe(403);
      expect(response.text).toBe("Not authorized");
    });
  });

  describe("GET /games/:id/edit", () => {
    it("should render edit game page for existing game", async () => {
      const mockGame = {
        id: 1,
        title: "Test Game",
        description: "Test Description",
        genre: "ACTION",
        slug: "test-game",
        developer: "Test Dev",
        publisher: "Test Pub",
        images: [],
        stream: "",
        manual: "",
        release: 2023,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(Game.findById).mockResolvedValue(mockGame as any);

      const response = await request(app)
        .get("/games/1/edit")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/edit-game");
      expect(response.body.data.game).toEqual(
        expect.objectContaining({
          id: 1,
          title: "Test Game",
        })
      );
      expect(Game.findById).toHaveBeenCalledWith("1");
    });

    it("should call next() for non-existing game", async () => {
      vi.mocked(Game.findById).mockResolvedValue(null);

      const response = await request(app)
        .get("/games/999/edit")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(404);
      expect(Game.findById).toHaveBeenCalledWith("999");
    });
  });

  describe("POST /games/:id", () => {
    const mockGame = { id: 1 };

    it("should update game successfully", async () => {
      vi.mocked(Game.update).mockResolvedValue(mockGame as any);

      const updateData = {
        title: "Updated Game",
        description: "Updated Description",
      };

      const response = await request(app)
        .post("/games/1")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        )
        .send(updateData);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
      expect(Game.update).toHaveBeenCalledWith("1", updateData);
    });

    it("should return 404 for non-existing game", async () => {
      vi.mocked(Game.update).mockResolvedValue(null as any);

      const response = await request(app)
        .post("/games/999")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        )
        .send({ title: "Updated Game" });

      expect(response.status).toBe(404);
      expect(response.text).toBe("Game not found");
    });
  });

  describe("POST /games/:id/delete", () => {
    it("should delete game successfully", async () => {
      vi.mocked(Game.delete).mockResolvedValue(undefined);

      const response = await request(app)
        .post("/games/1/delete")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
      expect(Game.delete).toHaveBeenCalledWith("1");
    });
  });

  describe("POST /games/:id/rate", () => {
    beforeEach(() => {
      vi.mocked(Game.rate).mockResolvedValue(undefined);
      vi.mocked(Game.getAverageRating).mockResolvedValue(4.5);
    });

    it("should rate game successfully with valid data", async () => {
      const response = await request(app)
        .post("/games/1/rate")
        .send({ rating: "5" });

      expect(response.status).toBe(200);
      expect(response.body.averageRating).toBe(4.5);
      expect(Game.rate).toHaveBeenCalledWith("1", "127.0.0.1", "5");
      expect(Game.getAverageRating).toHaveBeenCalledWith("1");
    });

    it("should return 400 for invalid game ID", async () => {
      const response = await request(app)
        .post("/games/invalid/rate")
        .send({ rating: "5" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid game ID");
    });

    it("should return 400 for rating less than 1", async () => {
      const response = await request(app)
        .post("/games/1/rate")
        .send({ rating: "0" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Rating must be between 1 and 5");
    });

    it("should return 400 for rating greater than 5", async () => {
      const response = await request(app)
        .post("/games/1/rate")
        .send({ rating: "6" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Rating must be between 1 and 5");
    });

    it("should return 400 for invalid rating format", async () => {
      const response = await request(app)
        .post("/games/1/rate")
        .send({ rating: "invalid" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Rating must be between 1 and 5");
    });

    it("should handle Game.rate errors", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      vi.mocked(Game.rate).mockRejectedValue(new Error("Database error"));

      const response = await request(app)
        .post("/games/1/rate")
        .send({ rating: "5" });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Internal server error");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error saving rating:",
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe("GET /games/:id", () => {
    it("should redirect to game detail page", async () => {
      const response = await request(app).get("/games/1");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/1");
    });
  });
});
