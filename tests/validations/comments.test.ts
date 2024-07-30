import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateComment } from "../../validations/comments";
import type { Request, Response, NextFunction } from "express";

describe("Comment Validations", () => {
  describe("validateComment", () => {
    const mockNext = vi.fn() as NextFunction;
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;

    beforeEach(() => {
      vi.clearAllMocks();

      mockReq = {
        flash: vi.fn(),
        get: vi.fn().mockReturnValue("/games/1"),
      };

      mockRes = {
        redirect: vi.fn(),
      };
    });

    it("should call next() for valid comment data", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "This is a valid comment",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.flash).not.toHaveBeenCalled();
      expect(mockRes.redirect).not.toHaveBeenCalled();
    });

    it("should allow comment without nick", () => {
      mockReq.body = {
        content: "Anonymous comment",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("should allow comment with null nick", () => {
      mockReq.body = {
        nick: null,
        content: "Anonymous comment with null nick",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.flash).not.toHaveBeenCalled();
      expect(mockRes.redirect).not.toHaveBeenCalled();
    });

    it("should allow comment with empty string nick", () => {
      mockReq.body = {
        nick: "",
        content: "Anonymous comment with empty nick",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.flash).not.toHaveBeenCalled();
      expect(mockRes.redirect).not.toHaveBeenCalled();
    });

    it("should reject nick longer than 255 characters", () => {
      mockReq.body = {
        nick: "a".repeat(256),
        content: "Valid content",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.flash).toHaveBeenCalledWith("error", "Nick is too long");
      expect(mockRes.redirect).toHaveBeenCalledWith("/games/1");
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should accept nick exactly 255 characters long", () => {
      mockReq.body = {
        nick: "a".repeat(255),
        content: "Valid content",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("should reject empty content", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.flash).toHaveBeenCalledWith(
        "error",
        "Content is required"
      );
      expect(mockRes.redirect).toHaveBeenCalledWith("/games/1");
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should reject content with only whitespace", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "   \n\t   ",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.flash).toHaveBeenCalledWith(
        "error",
        "Content is required"
      );
      expect(mockRes.redirect).toHaveBeenCalledWith("/games/1");
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should reject missing content", () => {
      mockReq.body = {
        nick: "TestUser",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.flash).toHaveBeenCalledWith(
        "error",
        "Content is required"
      );
      expect(mockRes.redirect).toHaveBeenCalledWith("/games/1");
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should accept content of medium length", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "a".repeat(500),
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.flash).not.toHaveBeenCalled();
      expect(mockRes.redirect).not.toHaveBeenCalled();
    });

    it("should reject content longer than 1000 characters", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "a".repeat(1001),
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.flash).toHaveBeenCalledWith(
        "error",
        "Content is too long"
      );
      expect(mockRes.redirect).toHaveBeenCalledWith("/games/1");
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should accept content exactly 1000 characters long", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "a".repeat(1000),
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("should reject invalid game ID", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "Valid content",
        gameId: "invalid",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.flash).toHaveBeenCalledWith("error", "Invalid game ID");
      expect(mockRes.redirect).toHaveBeenCalledWith("/games/1");
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should reject negative game ID", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "Valid content",
        gameId: "-1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.flash).toHaveBeenCalledWith("error", "Invalid game ID");
      expect(mockRes.redirect).toHaveBeenCalledWith("/games/1");
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should reject zero game ID", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "Valid content",
        gameId: "0",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.flash).toHaveBeenCalledWith("error", "Invalid game ID");
      expect(mockRes.redirect).toHaveBeenCalledWith("/games/1");
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should accept valid numeric game ID as string", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "Valid content",
        gameId: "123",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.flash).not.toHaveBeenCalled();
      expect(mockRes.redirect).not.toHaveBeenCalled();
    });

    it("should reject missing game ID", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "Valid content",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.flash).toHaveBeenCalledWith("error", "Invalid game ID");
      expect(mockRes.redirect).toHaveBeenCalledWith("/games/1");
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should redirect to root when no referer is available", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "",
        gameId: "1",
      };
      mockReq.get = vi.fn().mockReturnValue(undefined);

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.redirect).toHaveBeenCalledWith("/");
    });

    it("should redirect to root when no referer for nick too long", () => {
      mockReq.body = {
        nick: "a".repeat(256),
        content: "Valid content",
        gameId: "1",
      };
      mockReq.get = vi.fn().mockReturnValue(null);

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.flash).toHaveBeenCalledWith("error", "Nick is too long");
      expect(mockRes.redirect).toHaveBeenCalledWith("/");
    });

    it("should redirect to root when no referer for content too long", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "a".repeat(1001),
        gameId: "1",
      };
      mockReq.get = vi.fn().mockReturnValue(undefined);

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.flash).toHaveBeenCalledWith(
        "error",
        "Content is too long"
      );
      expect(mockRes.redirect).toHaveBeenCalledWith("/");
    });

    it("should redirect to root when no referer for invalid game ID", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "Valid content",
        gameId: "invalid",
      };
      mockReq.get = vi.fn().mockReturnValue(null);

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.flash).toHaveBeenCalledWith("error", "Invalid game ID");
      expect(mockRes.redirect).toHaveBeenCalledWith("/");
    });
  });
});
