import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateGame, validateGameRating } from "../../validations/games";
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

    // parseInt read "5abc" as 5, so the check passed and the route then handed
    // the untouched string to Postgres, which refused it — a 500 for a request
    // that belonged here.
    it("should return 400 for a game ID with trailing rubbish", () => {
      for (const id of ["5abc", "1.5", " 1", "1e3", "1 OR 1=1"]) {
        vi.clearAllMocks();

        mockReq = { params: { id }, body: { rating: "5" } };

        validateGameRating(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: "Invalid game ID",
        });
        expect(mockNext).not.toHaveBeenCalled();
      }
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

    // parseInt read whatever prefix looked numeric and ignored the rest, and
    // it stringifies its argument first — so "3.9" and an array both came
    // through as 3. A vote is a whole number or it is not a vote.
    it.each<[string, unknown]>([
      ["a fractional rating", "3.9"],
      ["a rating with trailing junk", "4abc"],
      ["a repeated field, which arrives as an array", ["3", "4"]],
      ["a rating sent as an object", { valueOf: () => 4 }],
      ["a negative rating", "-2"],
    ])("should return 400 for %s", (_label, rating) => {
      mockReq = { params: { id: "1" }, body: { rating } };

      validateGameRating(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Rating must be between 1 and 5",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    // The stars POST JSON, so the value arrives already typed.
    it("accepts a rating that arrives as a number", () => {
      mockReq = { params: { id: "1" }, body: { rating: 4 } };

      validateGameRating(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.body.rating).toBe(4);
    });

    // The route stores this and echoes it back, so it must not be "5".
    it("hands the route a number rather than the posted string", () => {
      mockReq = { params: { id: "1" }, body: { rating: "5" } };

      validateGameRating(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.body.rating).toBe(5);
    });
  });

  describe("validateGame", () => {
    const GENRES = ["ACTION", "RPG"];

    /** The minimum a valid game form posts. */
    const valid = (
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      title: "Doom",
      genre: "ACTION",
      ...extra,
    });

    it("accepts a valid game", () => {
      expect(validateGame(valid(), GENRES)).toEqual([]);
    });

    it("rejects an unknown genre", () => {
      const errors = validateGame(valid({ genre: "SHMUP" }), GENRES);

      expect(errors).toEqual([{ field: "genre", message: "Unknown genre" }]);
    });

    /**
     * Every check here reads the trimmed, uppercased value; only "images" was
     * written back in that form. So a value this function had already passed
     * could still be refused by the column behind it — the 500 page, with the
     * admin's entry gone, which is the failure it exists to prevent.
     */
    describe("writes back what it checked", () => {
      // A "release" of "   " cleared the emptiness test, because that test
      // trims, and then reached the INTEGER column as whitespace:
      // "invalid input syntax for type integer".
      it("blanks a whitespace-only release, which the model turns into NULL", () => {
        const data = valid({ release: "   " });

        expect(validateGame(data, GENRES)).toEqual([]);
        expect(data.release).toBe("");
      });

      it("leaves a real release alone but trims it", () => {
        const data = valid({ release: " 1993 " });

        expect(validateGame(data, GENRES)).toEqual([]);
        expect(data.release).toBe("1993");
      });

      // "action" cleared the enum test, because that test uppercases, and
      // then reached GAME_GENRE in lower case: "invalid input value for
      // enum game_genre".
      it("uppercases the genre, which is the form the enum holds", () => {
        const data = valid({ genre: "action" });

        expect(validateGame(data, GENRES)).toEqual([]);
        expect(data.genre).toBe("ACTION");
      });

      // Postgres trims only the *trailing* spaces when it casts to varchar,
      // so the leading ones survived into the column: the title rendered with
      // the gap and sorted before the whole catalogue in findAdjacentGames.
      it("trims the title", () => {
        const data = valid({ title: "  Spaced Title  " });

        expect(validateGame(data, GENRES)).toEqual([]);
        expect(data.title).toBe("Spaced Title");
      });

      // These two are matched with "=" by the developer and publisher pages,
      // so " id Software" is a studio of its own as far as getDevelopers()
      // and every link built from it are concerned.
      it("trims the developer and the publisher", () => {
        const data = valid({ developer: " id Software ", publisher: "\tGT\n" });

        expect(validateGame(data, GENRES)).toEqual([]);
        expect(data.developer).toBe("id Software");
        expect(data.publisher).toBe("GT");
      });

      it("trims the manual and the stream, which it checked trimmed", () => {
        const data = valid({
          manual: " https://example.com/m.pdf ",
          stream: " /assets/doom.jsdos ",
        });

        expect(validateGame(data, GENRES)).toEqual([]);
        expect(data.manual).toBe("https://example.com/m.pdf");
        expect(data.stream).toBe("/assets/doom.jsdos");
      });

      // serialize() writes only the columns it finds on the object, so a key
      // invented here would clear that column on any update whose form did
      // not carry the field.
      it("does not invent a field the request never sent", () => {
        const data = valid();

        expect(validateGame(data, GENRES)).toEqual([]);

        for (const field of [
          "release",
          "developer",
          "publisher",
          "manual",
          "stream",
          "images",
        ]) {
          expect(field in data, `"${field}" should stay absent`).toBe(false);
        }
      });

      // The form is re-rendered from req.body, so a refused request has to
      // come back holding what the admin actually typed.
      it("writes nothing back when anything was refused", () => {
        const data = valid({
          title: "  Spaced  ",
          genre: "action",
          release: "   ",
          stream: "javascript:alert(1)",
        });

        expect(validateGame(data, GENRES)).not.toEqual([]);

        expect(data.title).toBe("  Spaced  ");
        expect(data.genre).toBe("action");
        expect(data.release).toBe("   ");
        expect(data.stream).toBe("javascript:alert(1)");
      });
    });

    describe("images", () => {
      // The normalisation used to be local to the validator, so a lone
      // "images=..." — which express hands over as a bare string — was
      // approved here and then reached the TEXT[] column as a string, coming
      // back from Postgres as "malformed array literal": a 500 for a request
      // this function had already passed.
      it("writes a bare string back as an array", () => {
        const data = valid({ images: "https://example.com/a.png" });

        expect(validateGame(data, GENRES)).toEqual([]);
        expect(data.images).toEqual(["https://example.com/a.png"]);
      });

      it("keeps an array's values and its blank slots", () => {
        const data = valid({ images: ["https://example.com/a.png", ""] });

        expect(validateGame(data, GENRES)).toEqual([]);
        // The blank slot stays: the form posts four inputs, and the cover
        // getter is what skips an empty one.
        expect(data.images).toEqual(["https://example.com/a.png", ""]);
      });

      // hasSafeScheme reads the scheme off the front of the string, so a
      // value led by whitespace carried no scheme it could see and was waved
      // through as a relative path — which is exactly what a browser strips
      // the whitespace off and resolves. "manual" was always trimmed before
      // the check; the images were not.
      it("rejects a script URL hidden behind leading whitespace", () => {
        for (const image of [
          "\njavascript:alert(1)",
          "  javascript:alert(1)",
          "\tdata:text/html,<script>alert(1)</script>",
        ]) {
          expect(validateGame(valid({ images: [image] }), GENRES)).toEqual([
            {
              field: "images",
              message: "Image addresses must be http(s) or a path on this site",
            },
          ]);
        }
      });

      it("stores the trimmed address, which is the one it checked", () => {
        const data = valid({ images: ["  https://example.com/a.png  "] });

        expect(validateGame(data, GENRES)).toEqual([]);
        expect(data.images).toEqual(["https://example.com/a.png"]);
      });

      // serialize() only writes the columns the request actually mentioned,
      // so inventing an empty array here would clear the artwork on any
      // update whose form did not carry the field.
      it("leaves an absent field absent", () => {
        const data = valid();

        expect(validateGame(data, GENRES)).toEqual([]);
        expect("images" in data).toBe(false);
      });

      it("rejects a scheme that is not http(s)", () => {
        const data = valid({ images: "javascript:alert(1)" });
        const errors = validateGame(data, GENRES);

        expect(errors).toHaveLength(1);
        expect(errors[0]!.field).toBe("images");
      });

      it("does not write back a value it rejected", () => {
        const data = valid({ images: "javascript:alert(1)" });

        validateGame(data, GENRES);

        expect(data.images).toBe("javascript:alert(1)");
      });

      it("rejects a value that is not a string at all", () => {
        const data = valid({ images: { nested: "object" } });
        const errors = validateGame(data, GENRES);

        expect(errors).toEqual([
          { field: "images", message: "Invalid image address" },
        ]);
      });

      /**
       * "//evil.example.com/a.png" carries no scheme for the scheme check to
       * find, so it used to be waved through as a relative path — and it is
       * not one. A browser resolves it against the *page's* scheme and
       * fetches it from that host, which img-src then refuses, so the
       * artwork silently did not load. Not what an admin typing a path meant.
       */
      it("rejects a protocol-relative address", () => {
        const data = valid({ images: ["//evil.example.com/a.png"] });
        const errors = validateGame(data, GENRES);

        expect(errors).toEqual([
          {
            field: "images",
            message: "Image addresses must be http(s) or a path on this site",
          },
        ]);
      });

      // The distinction the check has to draw: one leading slash is a path on
      // this site, two is somebody else's host.
      it("still accepts an ordinary absolute path", () => {
        expect(
          validateGame(valid({ images: ["/images/a.png"] }), GENRES),
        ).toEqual([]);
      });
    });

    // "stream" had no check of any kind, though it is the same sort of value
    // as the addresses above: it is written into the player's src as
    // "/js-dos.html?stream=…" and fetched from there.
    describe("stream", () => {
      it("accepts a path on this site", () => {
        expect(
          validateGame(valid({ stream: "/assets/doom.jsdos" }), GENRES),
        ).toEqual([]);
      });

      it("accepts an http(s) address", () => {
        expect(
          validateGame(
            valid({ stream: "https://example.com/doom.jsdos" }),
            GENRES,
          ),
        ).toEqual([]);
      });

      it("accepts an empty value — plenty of entries are not playable", () => {
        expect(validateGame(valid({ stream: "" }), GENRES)).toEqual([]);
      });

      it("rejects a scheme that is not http(s)", () => {
        expect(
          validateGame(valid({ stream: "javascript:alert(1)" }), GENRES),
        ).toEqual([
          {
            field: "stream",
            message: "Stream must be an http(s) address or a path on this site",
          },
        ]);
      });

      it("rejects a script URL hidden behind leading whitespace", () => {
        expect(
          validateGame(valid({ stream: "\njavascript:alert(1)" }), GENRES),
        ).toHaveLength(1);
      });

      // Fetched by the player under connect-src, which refuses a host that is
      // neither this origin nor MEDIA_ORIGIN — so a "//host/…" bundle is a
      // game that does not start.
      it("rejects a protocol-relative address", () => {
        expect(
          validateGame(valid({ stream: "//evil.example.com/doom.jsdos" }), GENRES),
        ).toEqual([
          {
            field: "stream",
            message: "Stream must be an http(s) address or a path on this site",
          },
        ]);
      });
    });

    describe("manual", () => {
      it("accepts a path on this site", () => {
        expect(
          validateGame(valid({ manual: "/manuals/doom.pdf" }), GENRES),
        ).toEqual([]);
      });

      it("accepts an http(s) address", () => {
        expect(
          validateGame(valid({ manual: "https://example.com/doom.pdf" }), GENRES),
        ).toEqual([]);
      });

      it("accepts an empty value", () => {
        expect(validateGame(valid({ manual: "" }), GENRES)).toEqual([]);
      });

      it("rejects a scheme that is not http(s)", () => {
        expect(
          validateGame(valid({ manual: "javascript:alert(1)" }), GENRES),
        ).toEqual([
          {
            field: "manual",
            message: "Manual must be an http(s) address or a path on this site",
          },
        ]);
      });

      /**
       * A browser strips tab and newline from anywhere in a URL and leading
       * C0 controls from its front before it reads the scheme, so a value
       * whose scheme SCHEME cannot see is still "javascript:" by the time the
       * href is followed. Trimming catches the leading case; these are the
       * embedded ones.
       */
      it("rejects a scheme broken up by control characters", () => {
        for (const manual of [
          "java\nscript:alert(1)",
          "java\tscript:alert(1)",
          "javascript\r:alert(1)",
          "\u0001javascript:alert(1)",
          "https://example.com/doom\u007f.pdf",
        ]) {
          expect(validateGame(valid({ manual }), GENRES)).toEqual([
            {
              field: "manual",
              message: "Manual must be an http(s) address or a path on this site",
            },
          ]);
        }
      });

      // The one field where a protocol-relative address does not fail
      // visibly: it is an ordinary href, so the link simply went to somebody
      // else's site rather than to a manual on this one.
      it("rejects a protocol-relative address", () => {
        expect(
          validateGame(valid({ manual: "//evil.example.com/doom.pdf" }), GENRES),
        ).toEqual([
          {
            field: "manual",
            message: "Manual must be an http(s) address or a path on this site",
          },
        ]);
      });
    });

    /**
     * "description" was the one field this function checked nothing about: no
     * length, no trim, and — alone among the fields — never written back
     * either. The column is TEXT, so nothing downstream refused a paste of
     * any size.
     */
    describe("description", () => {
      it("accepts an empty value — plenty of entries have none", () => {
        expect(validateGame(valid({ description: "" }), GENRES)).toEqual([]);
      });

      it("accepts an ordinary description", () => {
        expect(
          validateGame(valid({ description: "<p>A landmark shooter.</p>" }), GENRES),
        ).toEqual([]);
      });

      it("trims it, and writes back what it checked", () => {
        const data = valid({ description: "  <p>Doom</p>  " });

        expect(validateGame(data, GENRES)).toEqual([]);
        expect(data.description).toBe("<p>Doom</p>");
      });

      it("rejects one past the limit", () => {
        const errors = validateGame(
          valid({ description: "A".repeat(10001) }),
          GENRES,
        );

        expect(errors).toEqual([
          {
            field: "description",
            message: "Description cannot be longer than 10000 characters",
          },
        ]);
      });

      it("accepts one exactly at the limit", () => {
        expect(
          validateGame(valid({ description: "A".repeat(10000) }), GENRES),
        ).toEqual([]);
      });

      // Measured on the sanitized value, as validations/news.ts does it:
      // sanitizing grows a string, so a description that passes when measured
      // raw could still be stored several times longer than the limit.
      it("measures the sanitized length, not the raw one", () => {
        // Each "<" becomes "&lt;", so 4,000 of them are 16,000 stored.
        const errors = validateGame(
          valid({ description: "<".repeat(4000) }),
          GENRES,
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]!.field).toBe("description");
      });

      // serialize() writes only the columns it finds on the object, so
      // inventing this key would clear the column on any update whose form did
      // not carry the field.
      it("does not invent the field when the form did not send it", () => {
        const data = valid();

        expect(validateGame(data, GENRES)).toEqual([]);
        expect("description" in data).toBe(false);
      });

      it("treats a repeated field as no description rather than throwing", () => {
        const data = valid({ description: ["a", "b"] });

        expect(validateGame(data, GENRES)).toEqual([]);
        expect(data.description).toBe("");
      });
    });
  });
});
