import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import sitemapRouter, { clearSitemapCache } from "../../routes/sitemap.ts";
import Game from "../../models/game.ts";

vi.mock("../../models/game", () => ({
  default: {
    find: vi.fn(),
    findForSitemap: vi.fn(),
    count: vi.fn(),
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

    // Default mock for count - returns a reasonable number for pagination
    vi.mocked(Game.count).mockResolvedValue(50);
  });

  describe("GET /sitemap-index.xml", () => {
    it("should return sitemap with correct headers", async () => {
      const mockGames = [
        {
          slug: "test-game",
          updatedAt: new Date("2025-06-01"),
        },
      ];

      vi.mocked(Game.findForSitemap).mockResolvedValue(mockGames as any);
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
          slug: "test-game",
          updatedAt: new Date("2025-06-01"),
        },
      ];

      vi.mocked(Game.findForSitemap).mockResolvedValue(mockGames as any);
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
      vi.mocked(Game.findForSitemap).mockRejectedValue(error);
      vi.mocked(Game.getGenres).mockRejectedValue(error);
      vi.mocked(Game.getDevelopers).mockRejectedValue(error);
      vi.mocked(Game.getPublishers).mockRejectedValue(error);
      vi.mocked(Game.getYears).mockRejectedValue(error);

      const response = await request(app).get("/sitemap-index.xml");

      expect(response.status).toBe(500);
      expect(response.text).toBe("Sitemap temporarily unavailable");
    });

    it("should use cached sitemap on subsequent requests", async () => {
      const mockGames = [
        {
          slug: "test-game",
          updatedAt: new Date("2025-06-01"),
        },
      ];

      vi.mocked(Game.findForSitemap).mockResolvedValue(mockGames as any);
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
      vi.mocked(Game.getDevelopers).mockResolvedValue(["Test Developer"]);
      vi.mocked(Game.getPublishers).mockResolvedValue(["Test Publisher"]);
      vi.mocked(Game.getYears).mockResolvedValue([2025]);

      // First request - generates sitemap
      const response1 = await request(app).get("/sitemap-index.xml");
      expect(response1.status).toBe(200);

      // Clear mock call history
      vi.clearAllMocks();

      // Second request - should use cached sitemap
      const response2 = await request(app).get("/sitemap-index.xml");
      expect(response2.status).toBe(200);

      // Verify database calls were not made on second request
      expect(Game.findForSitemap).not.toHaveBeenCalled();
      expect(Game.getGenres).not.toHaveBeenCalled();
    });
  });
});
