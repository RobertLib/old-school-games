import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import indexnowRoutes from "../../routes/indexnow.ts";
import IndexNow from "../../utils/indexnow.ts";
import Game from "../../models/game.ts";

// Mock dependencies
vi.mock("../../utils/indexnow.ts");
vi.mock("../../models/game.ts");

const app = express();

// Mock middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mock session and flash
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

// Add routes
app.use("/", indexnowRoutes);

describe("IndexNow Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /indexnow/submit-all", () => {
    it("should submit all games successfully for admin user", async () => {
      const mockGames = [
        {
          id: 1,
          slug: "game-1",
          genre: "ACTION",
          developer: "Dev1",
          publisher: "Pub1",
          release: 1990,
        },
        {
          id: 2,
          slug: "game-2",
          genre: "RPG",
          developer: "Dev2",
          publisher: "Pub2",
          release: 1995,
        },
      ];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION", "RPG"]);
      vi.mocked(IndexNow.submitUrls).mockResolvedValue({ success: true });

      const response = await request(app)
        .post("/indexnow/submit-all")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
      expect(Game.find).toHaveBeenCalledWith({ limit: 1000 });
      expect(IndexNow.submitUrls).toHaveBeenCalled();
    });

    it("should redirect to login for unauthenticated user", async () => {
      const response = await request(app).post("/indexnow/submit-all");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/login");
    });

    it("should return 403 for non-admin user", async () => {
      const response = await request(app)
        .post("/indexnow/submit-all")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "user@test.com", role: "USER" },
          })
        );

      expect(response.status).toBe(403);
      expect(response.text).toBe("Not authorized");
    });

    it("should handle case when no games found", async () => {
      vi.mocked(Game.find).mockResolvedValue([]);

      const response = await request(app)
        .post("/indexnow/submit-all")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
      expect(IndexNow.submitUrls).not.toHaveBeenCalled();
    });

    it("should handle IndexNow submission errors", async () => {
      const mockGames = [{ id: 1, slug: "game-1" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
      vi.mocked(IndexNow.submitUrls).mockResolvedValue({
        success: false,
        error: "API error",
      });

      const response = await request(app)
        .post("/indexnow/submit-all")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
    });
  });

  describe("POST /indexnow/submit-game/:id", () => {
    it("should submit specific game successfully", async () => {
      const mockGame = {
        id: 1,
        title: "Test Game",
        slug: "test-game",
        genre: "ACTION",
        developer: "Test Dev",
        publisher: "Test Pub",
        release: 1990,
      };

      vi.mocked(Game.findById).mockResolvedValue(mockGame as any);
      vi.mocked(IndexNow.submitGameUrls).mockResolvedValue({ success: true });

      const response = await request(app)
        .post("/indexnow/submit-game/1")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
      expect(Game.findById).toHaveBeenCalledWith("1");
      expect(IndexNow.submitGameUrls).toHaveBeenCalledWith(
        "test-game",
        "ACTION",
        "Test Dev",
        "Test Pub",
        1990
      );
    });

    it("should handle game not found", async () => {
      vi.mocked(Game.findById).mockResolvedValue(null);

      const response = await request(app)
        .post("/indexnow/submit-game/999")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
      expect(IndexNow.submitGameUrls).not.toHaveBeenCalled();
    });

    it("should handle IndexNow submission error", async () => {
      const mockGame = {
        id: 1,
        title: "Test Game",
        slug: "test-game",
        genre: "ACTION",
      };

      vi.mocked(Game.findById).mockResolvedValue(mockGame as any);
      vi.mocked(IndexNow.submitGameUrls).mockResolvedValue({
        success: false,
        error: "API error",
      });

      const response = await request(app)
        .post("/indexnow/submit-game/1")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
    });
  });

  describe("POST /indexnow/test", () => {
    it("should test IndexNow configuration successfully", async () => {
      vi.mocked(IndexNow.submitUrl).mockResolvedValue({ success: true });

      const response = await request(app)
        .post("/indexnow/test")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
      expect(IndexNow.submitUrl).toHaveBeenCalledWith("/");
    });

    it("should handle test failure", async () => {
      vi.mocked(IndexNow.submitUrl).mockResolvedValue({
        success: false,
        error: "Test error",
      });

      const response = await request(app)
        .post("/indexnow/test")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
    });

    it("should handle exception during test submission", async () => {
      vi.mocked(IndexNow.submitUrl).mockRejectedValue(
        new Error("Network error")
      );

      const response = await request(app)
        .post("/indexnow/test")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
    });
  });
});
