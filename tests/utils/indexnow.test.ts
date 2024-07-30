import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import IndexNow from "../../utils/indexnow.ts";

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock environment variables
const mockEnv = {
  INDEXNOW_KEY: "test-key-123",
  SITE_URL: "https://test.com",
};

describe("IndexNow", () => {
  let originalEnv: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Save original environment
    originalEnv = { ...process.env };

    // Set test environment variables
    process.env.INDEXNOW_KEY = mockEnv.INDEXNOW_KEY;
    process.env.SITE_URL = mockEnv.SITE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe("submitUrls", () => {
    it("should successfully submit URLs", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const urls = ["/game1", "/game2"];
      const result = await IndexNow.submitUrls(urls);

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.indexnow.org/indexnow",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            host: "test.com",
            key: "test-key-123",
            urlList: ["https://test.com/game1", "https://test.com/game2"],
          }),
        }
      );
    });

    it("should handle API key not configured", async () => {
      delete process.env.INDEXNOW_KEY;

      const result = await IndexNow.submitUrls(["/test"]);

      expect(result.success).toBe(false);
      expect(result.error).toBe("API key not configured");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should handle empty URL array", async () => {
      const result = await IndexNow.submitUrls([]);

      expect(result.success).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should handle API errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "Bad Request",
      });

      const result = await IndexNow.submitUrls(["/test"]);

      expect(result.success).toBe(false);
      expect(result.error).toBe("HTTP 400: Bad Request");
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await IndexNow.submitUrls(["/test"]);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
    });

    it("should convert relative URLs to absolute URLs", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const urls = [
        "/relative",
        "relative-no-slash",
        "https://absolute.com/test",
      ];
      await IndexNow.submitUrls(urls);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.indexnow.org/indexnow",
        expect.objectContaining({
          body: JSON.stringify({
            host: "test.com",
            key: "test-key-123",
            urlList: [
              "https://test.com/relative",
              "https://test.com/relative-no-slash",
              "https://absolute.com/test",
            ],
          }),
        })
      );
    });
  });

  describe("submitUrl", () => {
    it("should submit single URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await IndexNow.submitUrl("/single-game");

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.indexnow.org/indexnow",
        expect.objectContaining({
          body: JSON.stringify({
            host: "test.com",
            key: "test-key-123",
            urlList: ["https://test.com/single-game"],
          }),
        })
      );
    });
  });

  describe("submitGameUrls", () => {
    it("should submit game-related URLs with all parameters", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await IndexNow.submitGameUrls(
        "test-game",
        "ACTION",
        "Test Developer",
        "Test Publisher",
        1990
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.indexnow.org/indexnow",
        expect.objectContaining({
          body: JSON.stringify({
            host: "test.com",
            key: "test-key-123",
            urlList: [
              "https://test.com/test-game",
              "https://test.com/",
              "https://test.com/action",
              "https://test.com/developer/Test%20Developer",
              "https://test.com/publisher/Test%20Publisher",
              "https://test.com/year/1990",
              "https://test.com/letter/t",
              "https://test.com/sitemap-index.xml",
            ],
          }),
        })
      );
    });

    it("should submit minimal game URLs with only slug", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await IndexNow.submitGameUrls("test-game");

      expect(result.success).toBe(true);

      const expectedUrls = [
        "https://test.com/test-game",
        "https://test.com/",
        "https://test.com/letter/t",
        "https://test.com/sitemap-index.xml",
      ];

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.indexnow.org/indexnow",
        expect.objectContaining({
          body: JSON.stringify({
            host: "test.com",
            key: "test-key-123",
            urlList: expectedUrls,
          }),
        })
      );
    });

    it("should handle game slug starting with non-letter", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await IndexNow.submitGameUrls("123-game");

      expect(result.success).toBe(true);

      // Should not include letter page since "1" is not a letter
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.urlList).not.toContain("https://test.com/letter/1");
      expect(body.urlList).toContain("https://test.com/123-game");
    });
  });

  describe("submitGameDeletedUrls", () => {
    it("should submit URLs for deleted game", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await IndexNow.submitGameDeletedUrls("deleted-game");

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.indexnow.org/indexnow",
        expect.objectContaining({
          body: JSON.stringify({
            host: "test.com",
            key: "test-key-123",
            urlList: [
              "https://test.com/",
              "https://test.com/sitemap-index.xml",
            ],
          }),
        })
      );
    });

    it("should handle errors in submitGameDeletedUrls", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await IndexNow.submitGameDeletedUrls("deleted-game");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("submitUrl", () => {
    it("should successfully submit single URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await IndexNow.submitUrl("/single-page");

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.indexnow.org/indexnow",
        expect.objectContaining({
          body: JSON.stringify({
            host: "test.com",
            key: "test-key-123",
            urlList: ["https://test.com/single-page"],
          }),
        })
      );
    });

    it("should handle errors in submitUrl", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await IndexNow.submitUrl("/test");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
