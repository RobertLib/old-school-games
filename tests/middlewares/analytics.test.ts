import { beforeEach, describe, expect, it, vi } from "vitest";
import analytics from "../../middlewares/analytics";
import Analytics from "../../models/analytics";
import type { Request, Response, NextFunction } from "express";

vi.mock("../../models/analytics", () => ({
  default: {
    logVisit: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("Analytics Middleware", () => {
  const mockNext = vi.fn() as NextFunction;
  let mockReq: any;
  let mockRes: any;
  let originalSend: any;

  beforeEach(() => {
    vi.clearAllMocks();

    originalSend = vi.fn();
    mockRes = {
      send: originalSend,
      statusCode: 200,
    };

    mockReq = {
      method: "GET",
      path: "/games",
      hostname: "example.com",
      headers: {},
      connection: {},
      socket: {},
      session: {},
      get: vi.fn(),
    };
  });

  it("should call next() without errors", async () => {
    await analytics(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it("should log visit for valid GET request", async () => {
    const mockGet = vi
      .fn()
      .mockReturnValueOnce(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      )
      .mockReturnValueOnce("https://google.com");

    mockReq = {
      ...mockReq,
      get: mockGet,
      ip: "192.168.1.1",
      headers: {
        "x-forwarded-for": "192.168.1.1",
      },
    };

    await analytics(mockReq as Request, mockRes as Response, mockNext);

    mockRes.send!("response body");

    expect(Analytics.logVisit).toHaveBeenCalledWith({
      path: "/games",
      method: "GET",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ip: "192.168.1.1",
      referer: "https://google.com",
      timestamp: expect.any(Date),
    });
  });

  it("should not log visit for POST request", async () => {
    mockReq.method = "POST";

    await analytics(mockReq as Request, mockRes as Response, mockNext);
    mockRes.send!("response body");

    expect(Analytics.logVisit).not.toHaveBeenCalled();
  });

  it("should not log visit for static files", async () => {
    mockReq.path = "/css/style.css";

    await analytics(mockReq as Request, mockRes as Response, mockNext);
    mockRes.send!("response body");

    expect(Analytics.logVisit).not.toHaveBeenCalled();
  });

  it("should not log visit for localhost", async () => {
    mockReq.hostname = "localhost";

    await analytics(mockReq as Request, mockRes as Response, mockNext);
    mockRes.send!("response body");

    expect(Analytics.logVisit).not.toHaveBeenCalled();
  });

  it("should not log visit for admin users", async () => {
    mockReq.session = {
      user: { role: "ADMIN" },
    };

    await analytics(mockReq as Request, mockRes as Response, mockNext);
    mockRes.send!("response body");

    expect(Analytics.logVisit).not.toHaveBeenCalled();
  });

  it("should not log visit for error responses", async () => {
    mockRes.statusCode = 404;

    await analytics(mockReq as Request, mockRes as Response, mockNext);
    mockRes.send!("response body");

    expect(Analytics.logVisit).not.toHaveBeenCalled();
  });

  it("should handle multiple IPs from x-forwarded-for header", async () => {
    const mockGet = vi
      .fn()
      .mockReturnValueOnce(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      )
      .mockReturnValueOnce("");

    mockReq = {
      ...mockReq,
      get: mockGet,
      headers: {
        "x-forwarded-for": "192.168.1.1, 10.0.0.1, 172.16.0.1",
      },
    };

    await analytics(mockReq as Request, mockRes as Response, mockNext);
    mockRes.send!("response body");

    expect(Analytics.logVisit).toHaveBeenCalledWith({
      path: "/games",
      method: "GET",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ip: "192.168.1.1",
      referer: "",
      timestamp: expect.any(Date),
    });
  });

  it("should handle Analytics.logVisit errors gracefully", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.mocked(Analytics.logVisit).mockRejectedValueOnce(
      new Error("Database error")
    );

    const mockGet = vi
      .fn()
      .mockReturnValueOnce("Mozilla/5.0")
      .mockReturnValueOnce("");

    mockReq = {
      ...mockReq,
      get: mockGet,
      ip: "192.168.1.1",
    };

    await analytics(mockReq as Request, mockRes as Response, mockNext);
    mockRes.send!("response body");

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Analytics error:",
      expect.any(Error)
    );
    consoleErrorSpy.mockRestore();
  });
  it("should handle middleware errors gracefully", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const mockGet = vi.fn().mockImplementation(() => {
      throw new Error("Test error");
    });
    mockReq.get = mockGet;

    await analytics(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Analytics error:",
      expect.any(Error)
    );
    consoleErrorSpy.mockRestore();
  });

  describe("Static file detection", () => {
    const staticFiles = [
      "/css/style.css",
      "/js/script.js",
      "/images/logo.png",
      "/favicon.ico",
      "/file.svg",
      "/image.webp",
      "/photo.jpg",
      "/document.gif",
    ];

    staticFiles.forEach((path) => {
      it(`should detect "${path}" as static file`, async () => {
        mockReq.path = path;

        await analytics(mockReq as Request, mockRes as Response, mockNext);
        mockRes.send!("response body");

        expect(Analytics.logVisit).not.toHaveBeenCalled();
      });
    });
  });
});
