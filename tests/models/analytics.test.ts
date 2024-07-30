import { beforeEach, describe, expect, it, vi } from "vitest";
import Analytics from "../../models/analytics";
import db from "../../db";

vi.mock("../../db", () => ({
  default: {
    query: vi.fn(),
  },
}));

const mockDb = vi.mocked(db);

describe("Analytics Model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("logVisit", () => {
    it("should log a visit with correct parameters", async () => {
      const visitData = {
        path: "/games/123",
        method: "GET",
        userAgent: "Mozilla/5.0",
        ip: "192.168.1.1",
        referer: "https://google.com",
        timestamp: new Date("2025-06-09T10:00:00Z"),
      };

      (mockDb.query as any).mockResolvedValue({ rows: [], rowCount: 1 });

      await Analytics.logVisit(visitData);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO analytics"),
        [
          visitData.path,
          visitData.method,
          visitData.userAgent,
          visitData.ip,
          visitData.referer,
          visitData.timestamp,
        ]
      );
    });

    it("should handle empty referer", async () => {
      const visitData = {
        path: "/",
        method: "GET",
        userAgent: "Mozilla/5.0",
        ip: "192.168.1.1",
        referer: "",
        timestamp: new Date(),
      };

      (mockDb.query as any).mockResolvedValue({ rows: [], rowCount: 1 });

      await Analytics.logVisit(visitData);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO analytics"),
        expect.arrayContaining([visitData.referer])
      );
    });
  });

  describe("getPageStats", () => {
    it("should return page statistics for default 30 days", async () => {
      const mockStats = [
        { path: "/games", visits: 100, unique_visitors: 50 },
        { path: "/", visits: 80, unique_visitors: 40 },
      ];

      (mockDb.query as any).mockResolvedValue({ rows: mockStats });

      const result = await Analytics.getPageStats();

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("FROM analytics"),
        [30]
      );
      expect(result).toEqual(mockStats);
    });

    it("should return page statistics for custom number of days", async () => {
      const mockStats = [{ path: "/games", visits: 50, unique_visitors: 25 }];

      (mockDb.query as any).mockResolvedValue({ rows: mockStats });

      const result = await Analytics.getPageStats(7);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("FROM analytics"),
        [7]
      );
      expect(result).toEqual(mockStats);
    });

    it("should limit results to 20 pages", async () => {
      (mockDb.query as any).mockResolvedValue({ rows: [] });

      await Analytics.getPageStats();

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT 20"),
        [30]
      );
    });
  });

  describe("getDailyStats", () => {
    it("should return daily statistics", async () => {
      const mockStats = [
        { date: "2025-06-09", visits: 150, unique_visitors: 75 },
        { date: "2025-06-08", visits: 120, unique_visitors: 60 },
      ];

      (mockDb.query as any).mockResolvedValue({ rows: mockStats });

      const result = await Analytics.getDailyStats();

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("DATE(created_at) as date"),
        [30]
      );
      expect(result).toEqual(mockStats);
    });

    it("should accept custom number of days", async () => {
      (mockDb.query as any).mockResolvedValue({ rows: [] });

      await Analytics.getDailyStats(14);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("GROUP BY DATE(created_at)"),
        [14]
      );
    });
  });

  describe("getTotalStats", () => {
    it("should return total statistics", async () => {
      const mockStats = {
        total_visits: 1000,
        unique_visitors: 500,
        active_days: 25,
      };

      (mockDb.query as any).mockResolvedValue({ rows: [mockStats] });

      const result = await Analytics.getTotalStats();

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("COUNT(*) as total_visits"),
        [30]
      );
      expect(result).toEqual(mockStats);
    });

    it("should handle custom time period", async () => {
      const mockStats = {
        total_visits: 200,
        unique_visitors: 100,
        active_days: 7,
      };

      (mockDb.query as any).mockResolvedValue({ rows: [mockStats] });

      const result = await Analytics.getTotalStats(7);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("COUNT(DISTINCT ip) as unique_visitors"),
        [7]
      );
      expect(result).toEqual(mockStats);
    });
  });

  describe("getTopReferers", () => {
    it("should return top referers excluding own domain", async () => {
      const mockReferers = [
        { referer: "https://google.com", visits: 50 },
        { referer: "https://facebook.com", visits: 30 },
      ];

      (mockDb.query as any).mockResolvedValue({ rows: mockReferers });

      const result = await Analytics.getTopReferers();

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("referer NOT LIKE '%oldschoolgames.eu%'"),
        [30]
      );
      expect(result).toEqual(mockReferers);
    });

    it("should exclude empty referers", async () => {
      (mockDb.query as any).mockResolvedValue({ rows: [] });

      await Analytics.getTopReferers(7);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("referer != ''"),
        [7]
      );
    });

    it("should limit results to 10 referers", async () => {
      (mockDb.query as any).mockResolvedValue({ rows: [] });

      await Analytics.getTopReferers();

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT 10"),
        [30]
      );
    });
  });

  describe("error handling", () => {
    it("should handle database errors in logVisit", async () => {
      const visitData = {
        path: "/test",
        method: "GET",
        userAgent: "test",
        ip: "127.0.0.1",
        referer: "",
        timestamp: new Date(),
      };

      (mockDb.query as any).mockRejectedValue(new Error("Database error"));

      await expect(Analytics.logVisit(visitData)).rejects.toThrow(
        "Database error"
      );
    });

    it("should handle database errors in getPageStats", async () => {
      (mockDb.query as any).mockRejectedValue(new Error("Connection failed"));

      await expect(Analytics.getPageStats()).rejects.toThrow(
        "Connection failed"
      );
    });

    it("should handle database errors in getDailyStats", async () => {
      (mockDb.query as any).mockRejectedValue(new Error("Query timeout"));

      await expect(Analytics.getDailyStats()).rejects.toThrow("Query timeout");
    });

    it("should handle database errors in getTotalStats", async () => {
      (mockDb.query as any).mockRejectedValue(new Error("Invalid query"));

      await expect(Analytics.getTotalStats()).rejects.toThrow("Invalid query");
    });

    it("should handle database errors in getTopReferers", async () => {
      (mockDb.query as any).mockRejectedValue(
        new Error("Database unavailable")
      );

      await expect(Analytics.getTopReferers()).rejects.toThrow(
        "Database unavailable"
      );
    });
  });
});
