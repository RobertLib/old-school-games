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
    findFirstSlugs: vi.fn(),
  },
}));

vi.mock("../../models/news", () => ({
  default: {
    findAll: vi.fn(),
    findFirstSlugs: vi.fn(),
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

/**
 * Each item's <description> the way a feed reader shows it: the XML parsed,
 * and the text that comes out of it then read as HTML — which is what RSS 2.0
 * readers do with that element. `text` is what the reader sees; `elements` is
 * every element the fragment turned into, which for a plain-text summary must
 * be none.
 *
 * Asserting on the serialised document instead is how the double escape went
 * unnoticed: "Sam &amp; Max" looks right in the XML and is one decode short of
 * right in the reader.
 */
function descriptionsAsShown(
  xml: string,
): { text: string; elements: string[] }[] {
  const { window } = new JSDOM("");
  const feed = new window.DOMParser().parseFromString(xml, "text/xml");

  return [...feed.querySelectorAll("item > description")].map((node) => {
    const rendered = window.document.createElement("div");

    rendered.innerHTML = node.textContent ?? "";

    return {
      text: rendered.textContent ?? "",
      elements: [...rendered.querySelectorAll("*")].map((element) =>
        element.tagName.toLowerCase(),
      ),
    };
  });
}

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

    // No history by default, which is what an item that has never been
    // renamed looks like to the guid: its current address.
    vi.mocked(Game.findFirstSlugs).mockResolvedValue(new Map());
    vi.mocked(News.findFirstSlugs).mockResolvedValue(new Map());
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

    /**
     * The guid used to be the current address, and a rename moves it — so
     * every subscriber was shown a renamed game as a new one. It is now the
     * address the game was first published at, which still resolves (the
     * slug history 301s it) and never changes.
     */
    it("names a renamed game by the address it was first published at", async () => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          id: 7,
          title: "Doom II: Hell on Earth",
          slug: "doom-ii-hell-on-earth",
          description: "<p>Sequel.</p>",
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);
      vi.mocked(Game.findFirstSlugs).mockResolvedValue(new Map([[7, "doom-2"]]));

      const response = await request(server).get("/feed.xml");

      expect(Game.findFirstSlugs).toHaveBeenCalledWith([7]);
      expect(response.text).toContain(
        "<link>https://oldschoolgames.eu/doom-ii-hell-on-earth</link>",
      );
      expect(response.text).toContain(
        '<guid isPermaLink="true">https://oldschoolgames.eu/doom-2</guid>',
      );
    });

    // What makes the switch safe: an item never renamed keeps exactly the
    // guid it has always been published under, so nothing is re-announced.
    it("keeps the current address as the guid of a game never renamed", async () => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          id: 3,
          title: "Doom",
          slug: "doom",
          description: "",
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);

      const response = await request(server).get("/feed.xml");

      expect(response.text).toContain(
        '<guid isPermaLink="true">https://oldschoolgames.eu/doom</guid>',
      );
    });

    /**
     * What a reader shows for an ampersand an author typed.
     *
     * This used to assert the opposite of what it now does — that the
     * document carried "Sam &amp; Max" and never "&amp;amp;" — on the theory
     * that a reader displays a <description> as text. It does not: RSS 2.0
     * readers render it as HTML, so the one XML escape left them an HTML
     * fragment with a bare "&" in it, and every escaped "<" in an article
     * arrived as a tag. The escape that theory removed was the right one. See
     * descriptionsAsShown above.
     */
    it("shows a description's ampersand as the author typed it", async () => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          title: "Sam & Max",
          slug: "sam-max",
          // What Game.serialize stores for "Sam & Max <b>ride</b> again, and
          // &copy; is an entity": DOMPurify serialises each ampersand as one.
          // A bare "&" survives being read as HTML; "&copy;" does not — the
          // reader turned the author's text into a "©".
          description:
            "<p>Sam &amp; Max <b>ride</b> again, and &amp;copy; is an entity</p>",
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);

      const response = await request(server).get("/feed.xml");

      expect(descriptionsAsShown(response.text)).toEqual([
        { text: "Sam & Max ride again, and &copy; is an entity", elements: [] },
      ]);
    });

    /**
     * Text an author escaped, which the reader was handed as markup.
     *
     * The stored HTML is flattened and its entities decoded, so "&lt;Enter&gt;"
     * is the live text "<Enter>" by the time the feed is built — and one XML
     * escape made that a tag once the reader had parsed the XML. "Press
     * <Enter> to start" lost its "<Enter>", an article explaining "<b>" had
     * its next words turned bold, and a site embedding the feed was handed
     * markup it never asked for.
     */
    it.each([
      [
        "a key name in angle brackets",
        "<p>Press &lt;Enter&gt; to start</p>",
        "Press <Enter> to start",
      ],
      [
        "a tag written out as text",
        "<p>Wrap it in &lt;b&gt;bold&lt;/b&gt; to stress it</p>",
        "Wrap it in <b>bold</b> to stress it",
      ],
      [
        "markup a widget embedding the feed would run",
        '<p>&lt;img src="x" onerror="alert(1)"&gt;</p>',
        '<img src="x" onerror="alert(1)">',
      ],
    ])(
      "shows %s to a reader as text, not markup",
      async (_label, description, shown) => {
        vi.mocked(Game.findRecentForFeed).mockResolvedValue([
          {
            title: "Doom",
            slug: "doom",
            description,
            createdAt: new Date("2026-01-05T10:00:00Z"),
          },
        ] as any);

        const response = await request(server).get("/feed.xml");

        expect(descriptionsAsShown(response.text)).toEqual([
          { text: shown, elements: [] },
        ]);
      },
    );

    // The fallback is built from the title, which is plain text with
    // nothing escaped in it at all.
    it("shows a fallback description built from a title with markup in it", async () => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          title: "Sam & Max <Hit the Road>",
          slug: "sam-max",
          description: null,
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);

      const response = await request(server).get("/feed.xml");

      expect(descriptionsAsShown(response.text)).toEqual([
        {
          text: "Play Sam & Max <Hit the Road> online — a classic MS-DOS game.",
          elements: [],
        },
      ]);
    });

    // A <title> is plain text to a reader, so it keeps the single escape.
    it("keeps a title plain text", async () => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          title: "Sam & Max <Hit the Road>",
          slug: "sam-max",
          description: "",
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);

      const response = await request(server).get("/feed.xml");
      const { window } = new JSDOM("");
      const doc = new window.DOMParser().parseFromString(
        response.text,
        "text/xml",
      );

      expect(doc.querySelector("item > title")!.textContent).toBe(
        "Sam & Max <Hit the Road>",
      );
    });

    // A row that bypassed the sanitiser, flattened: the script is not prose.
    it("leaves a script's source out of the description", async () => {
      vi.mocked(Game.findRecentForFeed).mockResolvedValue([
        {
          title: "Doom",
          slug: "doom",
          description:
            "<p>Hello <script>alert(2)</script> x</p><style>body{}</style>",
          createdAt: new Date("2026-01-05T10:00:00Z"),
        },
      ] as any);

      const response = await request(server).get("/feed.xml");

      expect(descriptionsAsShown(response.text)).toEqual([
        { text: "Hello x", elements: [] },
      ]);
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

    /**
     * An outage is a blip, and this address is one a reader polls. With no
     * Cache-Control at all a shared cache is free to apply its own heuristic
     * freshness to the 500 — so a proxy could go on handing out "Feed
     * temporarily unavailable" long after the database came back.
     */
    it("forbids caching the failure", async () => {
      vi.mocked(Game.findRecentForFeed).mockRejectedValue(new Error("boom"));

      const response = await request(server).get("/feed.xml");

      expect(response.status).toBe(500);
      expect(response.headers["cache-control"]).toBe("no-store");
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

    // The same double escape as the games feed: both are built by one
    // function, and an article is where "&lt;" is most likely to be written.
    it("shows an article's escaped markup to a reader as text", async () => {
      vi.mocked(News.findAll).mockResolvedValue({
        news: [
          {
            title: "Keyboard help",
            slug: "keyboard-help",
            content: "<p>Press &lt;Enter&gt; &amp; then &lt;b&gt;.</p>",
            createdAt: new Date("2026-02-01T09:00:00Z"),
          },
        ],
        total: 1,
        totalPages: 1,
      } as any);

      const response = await request(server).get("/news/feed.xml");

      expect(descriptionsAsShown(response.text)).toEqual([
        { text: "Press <Enter> & then <b>.", elements: [] },
      ]);
    });

    it("names a renamed article by the address it was first published at", async () => {
      vi.mocked(News.findAll).mockResolvedValue({
        news: [
          {
            id: 4,
            title: "Twenty new classics",
            slug: "twenty-new-classics",
            content: "<p>More.</p>",
            createdAt: new Date("2026-02-01T09:00:00Z"),
          },
        ],
        total: 1,
        totalPages: 1,
      } as any);
      vi.mocked(News.findFirstSlugs).mockResolvedValue(
        new Map([[4, "ten-new-classics"]]),
      );

      const response = await request(server).get("/news/feed.xml");

      expect(response.text).toContain(
        "<link>https://oldschoolgames.eu/news/twenty-new-classics</link>",
      );
      expect(response.text).toContain(
        '<guid isPermaLink="true">https://oldschoolgames.eu/news/ten-new-classics</guid>',
      );
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
