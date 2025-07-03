import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import sitemapRouter, { clearSitemapCache } from "../../routes/sitemap.ts";
import Game from "../../models/game.ts";

vi.mock("../../models/game", () => ({
  default: {
    find: vi.fn(),
    getGenres: vi.fn(),
    getDevelopers: vi.fn(),
    getPublishers: vi.fn(),
    getYears: vi.fn(),
  },
}));

const app = express();
app.use("/", sitemapRouter);

describe("Sitemap Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSitemapCache();
  });

  describe("GET /sitemap-index.xml", () => {
    it("should return sitemap with correct headers", async () => {
      const mockGames = [
        {
          id: 1,
          slug: "test-game",
          updatedAt: new Date("2025-06-01"),
        },
      ];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
      vi.mocked(Game.getDevelopers).mockResolvedValue(["Test Developer"]);
      vi.mocked(Game.getPublishers).mockResolvedValue(["Test Publisher"]);
      vi.mocked(Game.getYears).mockResolvedValue([2025]);

      const response = await request(app).get("/sitemap-index.xml");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("application/xml");
      expect(response.headers["content-encoding"]).toBeUndefined();
    });

    it("should return valid XML content", async () => {
      const mockGames = [
        {
          id: 1,
          slug: "test-game",
          updatedAt: new Date("2025-06-01"),
        },
      ];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
      vi.mocked(Game.getDevelopers).mockResolvedValue(["Test Developer"]);
      vi.mocked(Game.getPublishers).mockResolvedValue(["Test Publisher"]);
      vi.mocked(Game.getYears).mockResolvedValue([2025]);

      const response = await request(app).get("/sitemap-index.xml");

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });

    it("should handle errors gracefully", async () => {
      const error = new Error("Database error");
      vi.mocked(Game.find).mockRejectedValue(error);
      vi.mocked(Game.getGenres).mockRejectedValue(error);
      vi.mocked(Game.getDevelopers).mockRejectedValue(error);
      vi.mocked(Game.getPublishers).mockRejectedValue(error);
      vi.mocked(Game.getYears).mockRejectedValue(error);

      const response = await request(app).get("/sitemap-index.xml");

      expect(response.status).toBe(500);
      expect(response.text).toBe("Sitemap temporarily unavailable");
    });
  });
});
