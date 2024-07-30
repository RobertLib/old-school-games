import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateGameRating } from "../../validations/games";
import type { Request, Response, NextFunction } from "express";

describe("Game Validations", () => {
  describe("validateGameRating", () => {
    const mockNext = vi.fn() as NextFunction;
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;

    beforeEach(() => {
      vi.clearAllMocks();

      mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      };
    });

    it("should call next() for valid game ID and rating", () => {
      mockReq = {
        params: { id: "1" },
        body: { rating: "5" },
      };

      validateGameRating(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid game ID", () => {
      mockReq = {
        params: { id: "invalid" },
        body: { rating: "5" },
      };

      validateGameRating(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Invalid game ID" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 400 for negative game ID", () => {
      mockReq = {
        params: { id: "-1" },
        body: { rating: "5" },
      };

      validateGameRating(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Invalid game ID" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 400 for zero game ID", () => {
      mockReq = {
        params: { id: "0" },
        body: { rating: "5" },
      };

      validateGameRating(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Invalid game ID" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 400 for rating below 1", () => {
      mockReq = {
        params: { id: "1" },
        body: { rating: "0" },
      };

      validateGameRating(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Rating must be between 1 and 5",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 400 for rating above 5", () => {
      mockReq = {
        params: { id: "1" },
        body: { rating: "6" },
      };

      validateGameRating(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Rating must be between 1 and 5",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid rating", () => {
      mockReq = {
        params: { id: "1" },
        body: { rating: "invalid" },
      };

      validateGameRating(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Rating must be between 1 and 5",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 400 for missing rating", () => {
      mockReq = {
        params: { id: "1" },
        body: {},
      };

      validateGameRating(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Rating must be between 1 and 5",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });
});
