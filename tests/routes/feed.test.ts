import { beforeEach, describe, expect, it, vi, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { JSDOM } from "jsdom";
import feedRouter, { clearFeedCache } from "../../routes/feed.ts";
import Game from "../../models/game.ts";
import News from "../../models/news.ts";

vi.mock("../../models/game", () => ({
  default: {
    findRecentForFeed: vi.fn(),
  },
}));

vi.mock("../../models/news", () => ({
  default: {
    findAll: vi.fn(),
  },
}));

const app = express();
app.use("/", feedRouter);

/**
 * One listening server for the whole file, handed to supertest directly.
 *
 * `request(app)` opens a fresh server on an ephemeral port for every single
 * call and closes it again when the response arrives — this suite did that a
 * few hundred times a run. Ports come back round: a request could be answered
 * by whatever had taken the port since, which showed up as an assertion
 * failing against a status the routes under test cannot even produce (a 401,
 * from an app with no authentication in it at all). Intermittent, unrelated to
 * the code being tested, and impossible to read.
 *
 * Passing the server instead means supertest opens and closes nothing.
 */
const server = app.listen(0);

afterAll(() => {
  server.close();
});

describe("Feed Routes", () => {
  /**
   * resetAllMocks, not clearAllMocks: the first drops the recorded calls
   * *and* the implementation, the second only the calls. Every test below
   * sets its own implementation, so nothing needs one to survive — and one
   * surviving is what made a failure here cascade.
   *
   * The mechanism, because it produced a flake that looked like nothing to do
   * with mocks: "does not remember a failed build" used to queue a one-shot
   * rejection with mockRejectedValueOnce on top of the resolved value the
   * previous test had left in place. A one-shot is consumed by a *call*, so
   * if the loader is not called — a cache entry surviving the clear below —
   * the rejection is not consumed either. It then fires on the next request
   * instead, failing this test's second half, and the resolved value it was
   * sitting on top of goes on to serve the test after that a document it
   * never asked for. One stale entry, three broken assertions, none of them
   * where the problem is.
   *
   * With the implementation reset per test there is no queue to leak, and the
   * tests that care assert the loader was called — so a stale entry fails
   * where it happens and says so.
   */
  beforeEach(() => {
    vi.resetAllMocks();
    clearFeedCache();
  });

  describe("GET /feed.xml", () => {
    it("serves an RSS document of recently added games", async () => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          title: "Doom",
          slug: "doom",
          description: "<p>Legendary <b>shooter</b>.</p>",
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);

      const response = await request(server).get("/feed.xml");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("application/rss+xml");
      expect(response.text).toContain("<title>Doom</title>");
      expect(response.text).toContain(
        "<link>https://oldschoolgames.eu/doom</link>",
      );
      // HTML is flattened to plain text for readers
      expect(response.text).toContain("Legendary shooter.");
      expect(response.text).not.toContain("<b>");
    });

    it("does not escape a description's entities a second time", async () => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          title: "Sam & Max",
          slug: "sam-max",
          // What Game.serialize stores for "Sam & Max <b>ride</b> again":
          // DOMPurify serialises the ampersand as an entity.
          description: "<p>Sam &amp; Max <b>ride</b> again</p>",
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);

      const response = await request(server).get("/feed.xml");

      // Once, by escapeXml. It used to be escaped on the way in as well, and
      // readers displayed the text "Sam &amp; Max".
      expect(response.text).toContain(
        "<description>Sam &amp; Max ride again</description>",
      );
      expect(response.text).not.toContain("&amp;amp;");
    });

    it("escapes XML-significant characters in titles", async () => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          title: "Sam & Max <Hit the Road>",
          slug: "sam-max",
          description: "",
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);

      const response = await request(server).get("/feed.xml");

      expect(response.text).toContain(
        "<title>Sam &amp; Max &lt;Hit the Road&gt;</title>",
      );
    });

    it("falls back to a generic description when a game has none", async () => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          title: "Quake",
          slug: "quake",
          description: null,
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);

      const response = await request(server).get("/feed.xml");

      expect(response.text).toContain("Play Quake online");
    });

    it("serves the cached document on the second request", async () => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([]);

      await request(server).get("/feed.xml");
      await request(server).get("/feed.xml");

      expect(Game.findRecentForFeed).toHaveBeenCalledTimes(1);
    });

    it("returns 500 when the database fails", async () => {
      vi.mocked(Game.findRecentForFeed).mockRejectedValue(new Error("boom"));

      const response = await request(server).get("/feed.xml");

      expect(response.status).toBe(500);
    });
  });

  describe("GET /news/feed.xml", () => {
    it("serves an RSS document of news items", async () => {
      vi.mocked(News.findAll).mockResolvedValue({
        news: [
          {
            title: "New games added",
            slug: "new-games-added",
            content: "<p>Ten more classics.</p>",
            createdAt: new Date("2026-02-01T09:00:00Z"),
          },
        ],
        total: 1,
        totalPages: 1,
      } as any);

      const response = await request(server).get("/news/feed.xml");

      expect(response.status).toBe(200);
      expect(response.text).toContain("<title>New games added</title>");
      expect(response.text).toContain(
        "<link>https://oldschoolgames.eu/news/new-games-added</link>",
      );
      expect(response.text).toContain("Ten more classics.");
    });
  });

  // The cache used to be a plain Map written only once a build had finished,
  // so two crawlers arriving together each ran the whole thing — the trap
  // /sitemap-index.xml was already out of. TtlCache holds the in-flight
  // promise instead, so they share one build.
  describe("caching", () => {
    it("builds once when two requests arrive on a cold cache", async () => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          title: "Doom",
          slug: "doom",
          description: "Legendary shooter.",
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);

      const [first, second] = await Promise.all([
        request(server).get("/feed.xml"),
        request(server).get("/feed.xml"),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.text).toBe(second.text);
      expect(Game.findRecentForFeed).toHaveBeenCalledTimes(1);
    });

    it("does not remember a failed build", async () => {
      // A plain rejecting implementation rather than mockRejectedValueOnce.
      // A one-shot is consumed by a call, so a request served from a stale
      // cache leaves it queued to fire on the next one — see the note on
      // beforeEach above. Replaced outright below instead.
      vi.mocked(Game.findRecentForFeed).mockRejectedValue(
        new Error("database is down"),
      );

      const failed = await request(server).get("/feed.xml");

      // Asserted before the status, because it is the assertion that explains
      // a failure rather than merely reporting one: a 200 here means the
      // request never reached the loader, so the cache was warm at the start
      // of a test whose whole subject is a cold one.
      expect(
        Game.findRecentForFeed,
        "the cache was not cold — the failing build never ran",
      ).toHaveBeenCalledTimes(1);

      expect(failed.status).toBe(500);
      expect(failed.text).toBe("Feed temporarily unavailable");

      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          title: "Doom",
          slug: "doom",
          description: "Legendary shooter.",
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);

      const recovered = await request(server).get("/feed.xml");

      expect(recovered.status).toBe(200);
      expect(recovered.text).toContain("<title>Doom</title>");

      // The point of the test: the failed build was dropped rather than
      // remembered, so this request had to build again. A cache that had kept
      // the rejection would have answered from it and never called out.
      expect(Game.findRecentForFeed).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * A control character cannot be escaped into legality — not even as
   * "&#1;" — so escaping the five markup characters and stopping there was
   * not enough to guarantee a well-formed document. Nothing upstream strips
   * them: DOMPurify keeps them, htmlToPlainText keeps them, and validateGame
   * only trims the ends of a title. One such character in one title therefore
   * cost every subscriber the whole feed rather than the one item.
   */
  describe("well-formedness", () => {
    /** Whether a feed reader could actually parse what was served. */
    function parses(xml: string): boolean {
      const { window } = new JSDOM("");
      const doc = new window.DOMParser().parseFromString(xml, "text/xml");

      return doc.querySelector("parsererror") === null;
    }

    it.each([
      ["a control character", `Doom${String.fromCharCode(1)}Collection`],
      ["a NUL", `Doom${String.fromCharCode(0)}II`],
      ["a lone surrogate", "Doom\uD800"],
      ["markup and an ampersand", `<script> & "Doom"`],
    ])("stays parseable when a title holds %s", async (_label, title) => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          title,
          slug: "doom",
          description: `Shooter${String.fromCharCode(2)} of the year`,
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);

      const response = await request(server).get("/feed.xml");

      expect(response.status).toBe(200);
      expect(parses(response.text)).toBe(true);
    });

    it("keeps the legible part of a title it had to clean", async () => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          title: `Doom${String.fromCharCode(1)} & Doom II`,
          slug: "doom",
          description: "Shooter.",
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);

      const response = await request(server).get("/feed.xml");

      expect(response.text).toContain("<title>Doom &amp; Doom II</title>");
    });
  });
});
