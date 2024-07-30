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
        // The second half of what isJsonRequest asks, and the default a
        // browser navigation gives: HTML preferred over JSON. Only the case
        // below overrides it.
        accepts: vi.fn().mockReturnValue("html"),
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

    /**
     * A caller that asks for JSON without sending any, which is what the bare
     * req.is("json") test here used to miss.
     *
     * Everything else answering this endpoint — the route's own refusals, its
     * success path, and the CSRF refusal in front of both — asks
     * isJsonRequest, which takes the Accept header when it names JSON ahead of
     * HTML. This one asked the content type alone, so the two halves of one
     * POST disagreed about who had sent it: the same client was handed a JSON
     * body by the route and an HTML document by this file. Two predicates for
     * one endpoint is how they drifted apart last time.
     */
    it("answers in JSON when the caller asks for JSON without sending any", () => {
      (mockReq.is as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (mockReq.accepts as ReturnType<typeof vi.fn>).mockReturnValue("json");
      mockReq.body = { content: "", gameId: "1" };

      validateComment(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Content is required",
      });
      expect(mockRes.render).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
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
      //
      // Nor is punctuation, a Unicode compatibility form, or a zero-width
      // character. Each of these renders beside a comment as the reserved
      // name itself: "admin." reads as "admin", the fullwidth letters are
      // "admin" in a wider font, and "ADMIN\u200b" is indistinguishable from
      // "ADMIN" on screen while /\s/ does not consider the zero-width space
      // whitespace at all. See normalizeNick in validations/comments.ts,
      // which also records what this still does not catch.
      it.each([
        "ADMIN",
        "  Admin  ",
        "Old  School   Games",
        "robert   libsansky",
        "admin.",
        "-admin-",
        "_admin_",
        "a.d.m.i.n",
        // A zero-width space, invisible to a reader and not whitespace to the
        // regular expression this used to collapse with.
        "ADMIN\u200b",
        "\u200badmin",
        // Fullwidth forms, which NFKC folds onto the ordinary letters and the
        // NFC everyone reaches for first does not.
        "\uff21\uff24\uff2d\uff29\uff2e",
        "old-school-games",
        "Robert.Libsansky",
        // The Hangul fillers are category Lo — letters — so the letter test
        // kept them, and they render as blank space: each of these displayed
        // as the reserved name. Default_Ignorable_Code_Point takes them out.
        "admin\u3164",
        "Robert\u3164Libsansky",
        "\uffa0admin",
        "ad\u115fmin",
        "admin\u1160",
        // The soft hyphen, which draws nothing except at a line break.
        "ad\u00admin",
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

      /**
       * The limitation, asserted rather than left for somebody to rediscover
       * as a bug report.
       *
       * "\u0430dmin" begins with a Cyrillic а, which is a letter and so
       * survives normalisation — it is not the Latin "a" and no amount of NFKC
       * will make it one. Catching it needs confusable folding (UTS #39) or a
       * script-mixing check, which is a dependency and a larger decision than
       * a denylist; normalizeNick in validations/comments.ts says so in
       * writing.
       *
       * This is here so the gap is a known, tested boundary: if somebody adds
       * confusable folding later, this test fails and is the place to record
       * that it now works.
       */
      it("does not catch a homoglyph, which is documented rather than fixed", () => {
        vi.clearAllMocks();
        mockReq.body = {
          nick: "\u0430dmin",
          content: "Valid content",
          gameId: "1",
        };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
      });

      // An empty nick is stored as "anonymous" by the route, not refused here.
      it("leaves an empty nick alone", () => {
        vi.clearAllMocks();
        mockReq.body = { nick: "", content: "Valid content", gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
      });
    });

    /**
     * Characters that change the order text is drawn in, which no comparison
     * of the characters can see through.
     *
     * normalizeNick drops them with the other default-ignorables, so
     * "\u202enimda" was compared as "nimda" — nowhere on the list — and stored
     * as sent. The browser then drew a right-to-left override followed by
     * "nimda", which reads "admin", in the h3 over the comment, on /comments
     * and in the Latest comments sidebar on every page. The spoof is in the
     * reordering, not in any one character, so the only answer is to refuse
     * the characters that do the reordering.
     */
    describe("text-direction controls", () => {
      const REFUSAL =
        "That nick contains invisible text-direction characters — please type it again without them";

      it.each([
        // The two the review found: they display as "admin" and as
        // "robert libsansky".
        ["a right-to-left override", "\u202enimda"],
        ["an override over two words", "\u202eyksnasbil trebor"],
        ["an override in the middle", "Bob\u202enimda"],
        ["a left-to-right override", "\u202dadmin"],
        ["the two embeddings", "\u202aadmin\u202c"],
        ["a right-to-left embedding", "\u202bnimda"],
        // An isolate does not escape the nick, but an override inside one
        // still applies inside it — which is why <bdi> is not the fix.
        ["the isolates", "\u2067\u202enimda\u2069"],
        ["a first-strong isolate", "\u2068admin\u2069"],
        ["a left-to-right isolate", "\u2066admin"],
        // The marks cannot reorder letters on their own, and are refused all
        // the same: the rule is one a visitor can be told in a sentence.
        ["a right-to-left mark", "admin\u200f"],
        ["a left-to-right mark", "\u200eadmin"],
        ["an Arabic letter mark", "\u061cadmin"],
      ])("refuses %s", (_label, nick) => {
        vi.clearAllMocks();
        mockReq.body = { nick, content: "Valid content", gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({ error: REFUSAL });
        expect(mockNext).not.toHaveBeenCalled();
      });

      // Whether or not what it spells is on the list: "\u202eolleh" draws as
      // "hello", and a nick that reads differently from what it is cannot be
      // judged by what it is.
      it("refuses one whatever it spells", () => {
        vi.clearAllMocks();
        mockReq.body = {
          nick: "\u202eolleh",
          content: "Valid content",
          gameId: "1",
        };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.json).toHaveBeenCalledWith({ error: REFUSAL });
      });

      // A form post gets the page, like every other refusal here.
      it("says so on the 400 page to a form post", () => {
        vi.clearAllMocks();
        (mockReq.is as ReturnType<typeof vi.fn>).mockReturnValue(false);
        mockReq.body = {
          nick: "\u202enimda",
          content: "Valid content",
          gameId: "1",
        };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.render).toHaveBeenCalledWith("400", {
          noindex: true,
          message: REFUSAL,
        });
      });

      /**
       * The comment body is the other half, and it is left alone on purpose.
       * It renders in a block of its own (div.comment-content, on the game
       * page and on /comments), and the bidi algorithm ends every embedding,
       * override and isolate at the end of its paragraph — so what an override
       * in the body can reorder is the body, which its writer controls
       * anyway. Neither the nick above it nor the rest of the page is in
       * reach.
       */
      it("leaves them in the comment body", () => {
        vi.clearAllMocks();
        const content = "\u202enimda si siht";

        mockReq.body = { nick: "Player", content, gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.body.content).toBe(content);
      });
    });

    /**
     * A nick nobody can see is no nick at all.
     *
     * "\u3164" — a Hangul filler — is a letter, so it was stored, and
     * `comment.nick || "anonymous"` treats any stored nick as present: the h3
     * over the comment rendered empty, the sidebar entry had nobody's name on
     * it, and "Replying to" named no one. Spaces were already treated this way
     * — the trim empties them — so what draws nothing now joins them and the
     * comment is posted as anonymous, rather than refused: the field is
     * optional, and a visitor who pasted a blank-looking name has not done
     * anything a retry would fix.
     */
    describe("nicks that draw nothing", () => {
      it.each([
        ["a Hangul filler", "\u3164"],
        ["several of them", "\u3164\u3164\u3164"],
        ["the halfwidth filler", "\uffa0"],
        ["a zero-width space", "\u200b"],
        ["the joiners on their own", "\u200c\u200d"],
        ["a soft hyphen", "\u00ad"],
        ["a word joiner between spaces", " \u2060 "],
        // Not a default-ignorable — it is a symbol — but the blank Braille
        // cell is the character a "blank name" is usually made of.
        ["the blank Braille cell", "\u2800\u2800"],
        ["control characters", "\u0007\u001b"],
        ["a next-line character, which trim() keeps", "\u0085"],
      ])("posts %s as anonymous", (_label, nick) => {
        vi.clearAllMocks();
        mockReq.body = { nick, content: "Valid content", gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.body.nick).toBe("");
      });

      // Whatever its length: it was never going to be shown.
      it("does not call a long one too long", () => {
        vi.clearAllMocks();
        mockReq.body = {
          nick: "\u3164".repeat(300),
          content: "Valid content",
          gameId: "1",
        };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.body.nick).toBe("");
      });

      // One visible character is a nick, and it is kept exactly as typed —
      // the invisible ones beside it included.
      it("keeps a nick with anything visible in it as typed", () => {
        vi.clearAllMocks();
        mockReq.body = {
          nick: "\u3164x\u3164",
          content: "Valid content",
          gameId: "1",
        };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.body.nick).toBe("\u3164x\u3164");
      });
    });

    /**
     * Real names in other scripts, which neither check above may cost
     * anything.
     *
     * Right-to-left names need no direction controls — the direction comes
     * from the letters themselves — so refusing the controls turns none of
     * them away. The zero-width non-joiner and joiner are kept in what is
     * stored: they are part of how Persian is spelled (علی\u200cرضا keeps its two
     * halves from joining) and of how an emoji family is one glyph, and they
     * cannot disguise a name — normalizeNick already compares through them.
     */
    describe("names in other scripts", () => {
      it.each([
        ["Persian, with a zero-width non-joiner", "علی\u200cرضا"],
        ["Arabic", "محمد"],
        ["Hebrew", "דוד"],
        ["Hebrew and digits", "דוד 2"],
        ["Cyrillic", "Иван Петров"],
        ["Czech", "Uživatel Žluťoučký"],
        ["Vietnamese", "Nguyễn Văn An"],
        ["Chinese", "李小龍"],
        ["Hindi, with a conjunct", "क्षत्रिय"],
        ["Malayalam, with a zero-width joiner", "ന്\u200d"],
        ["an emoji family", "👨\u200d👩\u200d👧"],
      ])("accepts %s and stores it as typed", (_label, nick) => {
        vi.clearAllMocks();
        mockReq.body = { nick, content: "Valid content", gameId: "1" };

        validateComment(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.body.nick).toBe(nick);
      });
    });
  });
});

/**
 * The textarea's maxlength counts a line break as one character, and a form
 * submitted without JavaScript sends it as CRLF — two. So a comment the form
 * had just accepted arrived longer than it and was refused as "too long".
 */
describe("line breaks in a comment", () => {
  function validate(content: string) {
    const req: Partial<Request> = {
      body: { content, gameId: "1" },
      flash: vi.fn(),
      get: vi.fn().mockReturnValue("/games/1"),
      is: vi.fn().mockReturnValue(false),
      accepts: vi.fn().mockReturnValue("html"),
    };
    const res: Partial<Response> = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      render: vi.fn(),
      redirect: vi.fn(),
    };
    const next = vi.fn();

    validateComment(req as Request, res as Response, next as NextFunction);

    return { req, next };
  }

  it("counts CRLF as the one character the form counted", () => {
    // 990 letters and ten line breaks: 1,000 as the textarea counts them,
    // 1,010 as a no-script form post sends them.
    const content = ("a".repeat(99) + "\r\n").repeat(10);

    expect(content.length).toBe(1_010);
    const { next } = validate(content);

    expect(next).toHaveBeenCalled();
  });

  it("stores line breaks as LF", () => {
    const { req } = validate("one\r\ntwo\rthree");

    expect(req.body.content).toBe("one\ntwo\nthree");
  });
});
