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
        // The fetch client sends JSON; the no-script form does not.
        is: vi.fn().mockReturnValue("json"),
      };

      mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        render: vi.fn(),
      };
    });

    describe("without scripts", () => {
      // A form-encoded post is the comment form submitted with JavaScript
      // off. Its refusal has to be a page, not a JSON body shown raw.
      it("renders the 400 page with the reason instead of JSON", () => {
        (mockReq.is as ReturnType<typeof vi.fn>).mockReturnValue(false);
        mockReq.body = { content: "", gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.render).toHaveBeenCalledWith("400", {
          noindex: true,
          message: "Content is required",
        });
        expect(mockRes.json).not.toHaveBeenCalled();
        expect(mockNext).not.toHaveBeenCalled();
      });

      it("still passes valid data through", () => {
        (mockReq.is as ReturnType<typeof vi.fn>).mockReturnValue(false);
        mockReq.body = { nick: "Player", content: "Great game", gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockRes.render).not.toHaveBeenCalled();
      });
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
    /**
     * A pattern check used to refuse anything containing "<script",
     * "javascript:" or "data:text/html", so a reader recommending a book
     * title was told their comment was an attack. The text is rendered
     * escaped, so the words are just words.
     */
    it("should accept prose that names a script URL or a tag", () => {
      for (const content of [
        "Read JavaScript: The Good Parts before touching this engine.",
        "the docs say <script> tags go at the bottom",
        "it starts with data:text/html, then the page",
      ]) {
        vi.clearAllMocks();

        mockReq.body = { nick: "TestUser", content, gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.body.content).toBe(content);
      }
    });

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

    /**
     * Nothing on the site marks a comment as official, so a comment signed
     * "admin" or with the owner's own name reads as the site saying it — which
     * is the whole value of writing it. There is no account behind a comment to
     * check against, so a short denylist is what is available.
     */
    describe("reserved nicks", () => {
      it.each([
        "admin",
        "administrator",
        "moderator",
        "staff",
        "oldschoolgames",
        "old school games",
        "Robert Libsansky",
      ])("refuses %s", (nick) => {
        vi.clearAllMocks();
        mockReq.body = { nick, content: "Valid content", gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: "That nick is reserved — please choose another",
        });
        expect(mockNext).not.toHaveBeenCalled();
      });

      // Case and surrounding or repeated whitespace are not a way round it —
      // otherwise the list refuses exactly one spelling of each name and
      // advertises the rest.
      it.each([
        "ADMIN",
        "  Admin  ",
        "Old  School   Games",
        "robert   libsansky",
      ])("refuses %s too", (nick) => {
        vi.clearAllMocks();
        mockReq.body = { nick, content: "Valid content", gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      // Deliberately narrow: a name that merely contains a reserved word is
      // somebody's actual nick, and refusing it would be the "Invalid content"
      // mistake the comment in validations/comments.ts describes.
      it.each(["administrators", "admin2", "Not Robert Libsansky", "Roberta"])(
        "leaves %s alone",
        (nick) => {
          vi.clearAllMocks();
          mockReq.body = { nick, content: "Valid content", gameId: "1" };

          validateComment(mockReq as Request, mockRes as Response, mockNext);

          expect(mockNext).toHaveBeenCalled();
        },
      );

      // An empty nick is stored as "anonymous" by the route, not refused here.
      it("leaves an empty nick alone", () => {
        vi.clearAllMocks();
        mockReq.body = { nick: "", content: "Valid content", gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
      });
    });
  });
});
