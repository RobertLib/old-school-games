import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import analyticsRouter from "../../routes/analytics";
import Analytics from "../../models/analytics";

vi.mock("../../middlewares/is-auth", () => ({
  default: (req: any, res: any, next: any) => {
    if (req.session?.user) {
      next();
    } else {
      res.redirect("/login");
    }
  },
}));

vi.mock("../../middlewares/is-admin", () => ({
  default: (req: any, res: any, next: any) => {
    if (req.session?.user?.role === "ADMIN") {
      next();
    } else {
      res.status(403).send("Not authorized");
    }
  },
}));

vi.mock("../../models/analytics", () => ({
  default: {
    getPageStats: vi.fn(),
    getDailyStats: vi.fn(),
    getTotalStats: vi.fn(),
    getTopReferers: vi.fn(),
  },
}));

const app = express();

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
  res.render = vi.fn((view, data) => {
    res.json({ view, data });
  });
  next();
});

app.use(analyticsRouter);

describe("Analytics Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /analytics", () => {
    const mockPageStats = [
      { path: "/", visits: 100, unique_visitors: 80 },
      { path: "/games", visits: 50, unique_visitors: 40 },
    ];

    const mockDailyStats = [
      { date: "2025-06-09", visits: 150, unique_visitors: 120 },
      { date: "2025-06-08", visits: 130, unique_visitors: 100 },
    ];

    const mockTotalStats = {
      total_visits: 1000,
      unique_visitors: 800,
      active_days: 30,
    };

    const mockTopReferers = [
      { referer: "https://google.com", visits: 200 },
      { referer: "https://facebook.com", visits: 150 },
    ];

    beforeEach(() => {
      vi.mocked(Analytics.getPageStats).mockResolvedValue(mockPageStats);
      vi.mocked(Analytics.getDailyStats).mockResolvedValue(mockDailyStats);
      vi.mocked(Analytics.getTotalStats).mockResolvedValue(mockTotalStats);
      vi.mocked(Analytics.getTopReferers).mockResolvedValue(mockTopReferers);
    });

    it("should return analytics dashboard for authenticated admin user", async () => {
      const response = await request(app)
        .get("/analytics")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("analytics/dashboard");
      expect(response.body.data).toEqual({
        pageStats: mockPageStats,
        dailyStats: mockDailyStats,
        totalStats: mockTotalStats,
        topReferers: mockTopReferers,
        days: 30,
        title: "Analytics Dashboard - OldSchoolGames",
      });

      expect(Analytics.getPageStats).toHaveBeenCalledWith(30);
      expect(Analytics.getDailyStats).toHaveBeenCalledWith(30);
      expect(Analytics.getTotalStats).toHaveBeenCalledWith(30);
      expect(Analytics.getTopReferers).toHaveBeenCalledWith(30);
    });

    it("should use custom days parameter when provided", async () => {
      await request(app)
        .get("/analytics?days=7")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(Analytics.getPageStats).toHaveBeenCalledWith(7);
      expect(Analytics.getDailyStats).toHaveBeenCalledWith(7);
      expect(Analytics.getTotalStats).toHaveBeenCalledWith(7);
      expect(Analytics.getTopReferers).toHaveBeenCalledWith(7);
    });

    it("should handle invalid days parameter and default to 30", async () => {
      await request(app)
        .get("/analytics?days=invalid")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(Analytics.getPageStats).toHaveBeenCalledWith(30);
      expect(Analytics.getDailyStats).toHaveBeenCalledWith(30);
      expect(Analytics.getTotalStats).toHaveBeenCalledWith(30);
      expect(Analytics.getTopReferers).toHaveBeenCalledWith(30);
    });

    it("should return 401 for unauthenticated user", async () => {
      const response = await request(app).get("/analytics");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/login");
    });

    it("should return 403 for authenticated non-admin user", async () => {
      const response = await request(app)
        .get("/analytics")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "user@test.com", role: "USER" },
          })
        );

      expect(response.status).toBe(403);
      expect(response.text).toBe("Not authorized");
    });

    it("should handle Analytics model errors", async () => {
      vi.mocked(Analytics.getPageStats).mockRejectedValue(
        new Error("Database error")
      );

      const response = await request(app)
        .get("/analytics")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(500);
    });

    it("should pass the correct days value to the view", async () => {
      const response = await request(app)
        .get("/analytics?days=14")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "admin@test.com", role: "ADMIN" },
          })
        );

      expect(response.status).toBe(200);
      expect(response.body.data.days).toBe(14);
    });
  });
});
