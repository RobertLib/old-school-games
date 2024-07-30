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
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
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
      expect(mockRes.status).not.toHaveBeenCalled();
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
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it("should allow comment with empty string nick", () => {
      mockReq.body = {
        nick: "",
        content: "Anonymous comment with empty nick",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it("should reject nick longer than 255 characters", () => {
      mockReq.body = {
        nick: "a".repeat(256),
        content: "Valid content",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Nick is too long",
      });
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

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Content is required",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should reject content with only whitespace", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "   \n\t   ",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Content is required",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should reject missing content", () => {
      mockReq.body = {
        nick: "TestUser",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Content is required",
      });
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
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it("should reject content longer than 1000 characters", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "a".repeat(1001),
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Content is too long",
      });
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

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Invalid game ID",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should reject negative game ID", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "Valid content",
        gameId: "-1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Invalid game ID",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should reject zero game ID", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "Valid content",
        gameId: "0",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Invalid game ID",
      });
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
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it("should reject missing game ID", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "Valid content",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Invalid game ID",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    // "content[]=hi" arrives as an array, and content.trim() threw on it —
    // a 500 for what is only a malformed form post.
    it("should reject a non-string content instead of throwing", () => {
      for (const content of [["hi"], { a: "b" }, 5, true]) {
        vi.clearAllMocks();

        mockReq.body = { nick: "TestUser", content, gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: "Content is required",
        });
        expect(mockNext).not.toHaveBeenCalled();
      }
    });

    // The nick is stored as typed and escaped at render, so 255 characters
    // is 255 characters whatever they are. It used to be sanitized first,
    // which turned each "<" into "&lt;" and made this 1020 — rejected as too
    // long for a nick that fits the column perfectly well.
    it("should accept a nick of 255 characters whatever they are", () => {
      mockReq.body = {
        nick: "<".repeat(255),
        content: "Valid content",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.body.nick).toBe("<".repeat(255));
    });

    it("should reject a nick longer than the column holds", () => {
      mockReq.body = {
        nick: "a".repeat(256),
        content: "Valid content",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Nick is too long" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    // Sanitizing here escaped the text a second time — the views already
    // render a comment through EJS's <%= %> — so "<3" was stored as "&lt;3"
    // and the reader was shown the literal characters "&lt;3".
    it("should store the text exactly as it was typed", () => {
      for (const content of ["<3 this game", "Speedrun in 5 < 10 minutes"]) {
        vi.clearAllMocks();

        mockReq.body = { nick: "TestUser", content, gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.body.content).toBe(content);
      }
    });

    it("should trim the nick but leave its characters alone", () => {
      mockReq.body = {
        nick: "  <b>Nick</b>  ",
        content: "Valid content",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.body.nick).toBe("<b>Nick</b>");
    });

    // "<iframe></iframe>" is neither empty nor a script tag, so it clears
    // every other check while carrying no text at all — a blank comment.
    it("should reject content that is nothing but markup", () => {
      for (const content of [
        "<iframe></iframe>",
        "<b></b>",
        "<div>   </div>",
      ]) {
        vi.clearAllMocks();

        mockReq.body = { nick: "TestUser", content, gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: "Content is required",
        });
        expect(mockNext).not.toHaveBeenCalled();
      }
    });

    // Dropping tags is how the emptiness check above works, but it must not
    // touch what gets stored: "< b >" is a run of ordinary characters here,
    // not a tag, and stripping it would eat the middle of the sentence.
    it("should accept prose that looks like a tag", () => {
      mockReq.body = { nick: "TestUser", content: "a < b > c", gameId: "1" };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.body.content).toBe("a < b > c");
    });

    it("should reject a non-string nick instead of throwing", () => {
      mockReq.body = {
        nick: ["a", "b"],
        content: "Valid content",
        gameId: "1",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Invalid nick" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    // parseInt read "5abc" as 5, so the check passed and the untouched string
    // went on to Postgres, which refused it as a bad integer — a 500.
    it("should reject a game ID with trailing rubbish", () => {
      for (const gameId of ["5abc", "1.5", " 1", "1 OR 1=1", ["1"]]) {
        vi.clearAllMocks();

        mockReq.body = { nick: "TestUser", content: "Valid content", gameId };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: "Invalid game ID",
        });
        expect(mockNext).not.toHaveBeenCalled();
      }
    });

    it("should reject a parent ID with trailing rubbish", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "Valid content",
        gameId: "1",
        parentId: "7abc",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Invalid parent comment",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    // The route inserts these straight into Postgres, so they leave here as
    // numbers rather than as whatever the form happened to send.
    it("should hand the route numeric ids", () => {
      mockReq.body = {
        nick: "TestUser",
        content: "Valid content",
        gameId: "123",
        parentId: "45",
      };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.body.gameId).toBe(123);
      expect(mockReq.body.parentId).toBe(45);
    });

    it("should normalise an absent parent ID to null", () => {
      for (const parentId of [undefined, null, ""]) {
        vi.clearAllMocks();

        mockReq.body = {
          nick: "TestUser",
          content: "Valid content",
          gameId: "1",
          parentId,
        };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.body.parentId).toBeNull();
      }
    });

    // Rejections used to redirect to the Referer, which the fetch-based form
    // followed and rendered into the thread. The answer is now the same
    // machine-readable 400 no matter where the request came from.
    it("should reject with JSON regardless of the referer", () => {
      for (const referer of [undefined, null, "/games/1", "http://evil/x"]) {
        vi.clearAllMocks();

        mockReq.body = { nick: "TestUser", content: "", gameId: "1" };
        mockReq.get = vi.fn().mockReturnValue(referer);

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: "Content is required",
        });
        expect(mockRes.redirect).toBeUndefined();
        expect(mockNext).not.toHaveBeenCalled();
      }
    });
  });
});
