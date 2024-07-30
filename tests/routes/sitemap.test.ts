import { beforeEach, describe, expect, it, vi, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { JSDOM } from "jsdom";
import sitemapRouter, {
  clearSitemapCache,
  robotsTxt,
} from "../../routes/sitemap.ts";
import Game from "../../models/game.ts";
import News from "../../models/news.ts";

vi.mock("../../models/game", () => ({
  default: {
    find: vi.fn(),
    findForSitemap: vi.fn(),
    count: vi.fn(),
    getGenres: vi.fn(),
    getDevelopers: vi.fn(),
    getPublishers: vi.fn(),
    getYears: vi.fn(),
    getSitemapCounts: vi.fn(),
  },
}));

/**
 * What Game.getSitemapCounts answers for a catalogue with nothing in it.
 *
 * It returns the counts and the per-group MAX("updatedAt") off one GROUP BY,
 * so a mock has to supply both halves; a bare Map was all it used to be.
 */
const emptySitemapCounts = () => ({
  counts: new Map<string, number>(),
  lastmods: new Map<string, string>(),
});

const app = express();
// Mounted the way app.ts mounts it: ahead of everything that would hand a
// crawler a cookie, which is why it is an exported handler rather than a
// route on the sitemap router.
app.get("/robots.txt", robotsTxt);
app.use("/", sitemapRouter);
app.use((req, res) => res.status(404).send("not found"));

function seedMocks() {
  vi.mocked(Game.findForSitemap).mockResolvedValue([
    { slug: "test-game", updatedAt: new Date("2025-06-01") },
  ] as any);
  vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
  vi.mocked(Game.getDevelopers).mockResolvedValue(["Test Developer"]);
  vi.mocked(Game.getPublishers).mockResolvedValue(["Test Publisher"]);
  vi.mocked(Game.getYears).mockResolvedValue([2025]);
  vi.mocked(Game.getSitemapCounts).mockResolvedValue(emptySitemapCounts());
}

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

describe("Sitemap Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSitemapCache();

    // Default mock for count - returns a reasonable number for pagination
    vi.mocked(Game.count).mockResolvedValue(50);
    vi.mocked(Game.getSitemapCounts).mockResolvedValue(emptySitemapCounts());
  });

  describe("GET /sitemap-index.xml", () => {
    it("should return sitemap with correct headers", async () => {
      const mockGames = [
        {
          slug: "test-game",
          updatedAt: new Date("2025-06-01"),
        },
      ];

      vi.mocked(Game.findForSitemap).mockResolvedValue(mockGames as any);
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
      vi.mocked(Game.getDevelopers).mockResolvedValue(["Test Developer"]);
      vi.mocked(Game.getPublishers).mockResolvedValue(["Test Publisher"]);
      vi.mocked(Game.getYears).mockResolvedValue([2025]);
      vi.mocked(Game.getSitemapCounts).mockResolvedValue(emptySitemapCounts());

      const response = await request(server).get("/sitemap-index.xml");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("application/xml");
      expect(response.headers["content-encoding"]).toBeUndefined();
    });

    it("should return valid XML content", async () => {
      const mockGames = [
        {
          slug: "test-game",
          updatedAt: new Date("2025-06-01"),
        },
      ];

      vi.mocked(Game.findForSitemap).mockResolvedValue(mockGames as any);
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
      vi.mocked(Game.getDevelopers).mockResolvedValue(["Test Developer"]);
      vi.mocked(Game.getPublishers).mockResolvedValue(["Test Publisher"]);
      vi.mocked(Game.getYears).mockResolvedValue([2025]);
      vi.mocked(Game.getSitemapCounts).mockResolvedValue(emptySitemapCounts());

      const response = await request(server).get("/sitemap-index.xml");

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });

    it("should handle errors gracefully", async () => {
      const error = new Error("Database error");
      vi.mocked(Game.findForSitemap).mockRejectedValue(error);
      vi.mocked(Game.getGenres).mockRejectedValue(error);
      vi.mocked(Game.getDevelopers).mockRejectedValue(error);
      vi.mocked(Game.getPublishers).mockRejectedValue(error);
      vi.mocked(Game.getYears).mockRejectedValue(error);
      vi.mocked(Game.getSitemapCounts).mockRejectedValue(error);

      const response = await request(server).get("/sitemap-index.xml");

      expect(response.status).toBe(500);
      expect(response.text).toBe("Sitemap temporarily unavailable");
      // No Cache-Control at all lets a shared cache invent its own freshness,
      // and a crawler handed this plain-text apology out of a proxy after the
      // outage is over is worse than one handed it during it.
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("should use cached sitemap on subsequent requests", async () => {
      const mockGames = [
        {
          slug: "test-game",
          updatedAt: new Date("2025-06-01"),
        },
      ];

      vi.mocked(Game.findForSitemap).mockResolvedValue(mockGames as any);
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
      vi.mocked(Game.getDevelopers).mockResolvedValue(["Test Developer"]);
      vi.mocked(Game.getPublishers).mockResolvedValue(["Test Publisher"]);
      vi.mocked(Game.getYears).mockResolvedValue([2025]);
      vi.mocked(Game.getSitemapCounts).mockResolvedValue(emptySitemapCounts());

      // First request - generates sitemap
      const response1 = await request(server).get("/sitemap-index.xml");
      expect(response1.status).toBe(200);

      // Clear mock call history
      vi.clearAllMocks();

      // Second request - should use cached sitemap
      const response2 = await request(server).get("/sitemap-index.xml");
      expect(response2.status).toBe(200);

      // Verify database calls were not made on second request
      expect(Game.findForSitemap).not.toHaveBeenCalled();
      expect(Game.getGenres).not.toHaveBeenCalled();
    });

    // The route served every URL as one <urlset> while being named an index.
    it("is a sitemap index that points at the chunk files", async () => {
      seedMocks();

      const response = await request(server).get("/sitemap-index.xml");

      expect(response.text).toContain(
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      );
      expect(response.text).toContain(
        "<loc>https://oldschoolgames.eu/sitemap-1.xml</loc>",
      );
      expect(response.text).not.toContain("<urlset");
      expect(response.text).not.toContain("<url>");
    });
  });

  describe("GET /sitemap-:page.xml", () => {
    it("serves the first chunk as a urlset containing the game URLs", async () => {
      seedMocks();

      const response = await request(server).get("/sitemap-1.xml");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("application/xml");
      expect(response.text).toContain(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      );
      expect(response.text).toContain(
        "<loc>https://oldschoolgames.eu/test-game</loc>",
      );
      expect(response.text).not.toContain("<sitemapindex");
    });

    it("reuses the cache the index already built", async () => {
      seedMocks();

      await request(server).get("/sitemap-index.xml");
      vi.clearAllMocks();

      const response = await request(server).get("/sitemap-1.xml");

      expect(response.status).toBe(200);
      expect(Game.findForSitemap).not.toHaveBeenCalled();
    });

    // /how-to-play was listed and /about was not, so a standing page with
    // content worth ranking was left to be found by crawl alone.
    it.each(["/about", "/how-to-play"])(
      "lists the standing page %s",
      async (url) => {
        seedMocks();

        const response = await request(server).get("/sitemap-1.xml");

        expect(response.text).toContain(
          `<loc>https://oldschoolgames.eu${url}</loc>`,
        );
      },
    );

    /**
     * The two legal pages, which this suite used to assert were absent.
     *
     * They were left out for as long as routes/home.ts marked them noindex,
     * and that was right: a sitemap is the list of pages a site wants indexed,
     * so submitting one that refuses is what Search Console reports back as
     * "Submitted URL marked 'noindex'". The tag is gone — a privacy policy and
     * a DMCA route are evidence a rater looks for, and a noindex on a page
     * linked from every footer eventually costs the links as well — so the
     * reason to exclude them went with it. See routes/home.ts.
     */
    it.each(["/privacy-policy", "/dmca"])(
      "lists the legal page %s",
      async (url) => {
        seedMocks();

        const response = await request(server).get("/sitemap-1.xml");

        expect(response.text).toContain(
          `<loc>https://oldschoolgames.eu${url}</loc>`,
        );
      },
    );

    /**
     * The invariant the block above used to carry, kept pointed at pages that
     * still hold it. /login and /profile are noindex and stay that way — one
     * is a form, the other is one visitor's own page — and views/footer.ejs
     * links both from every page on the site, which is exactly how they got
     * into a sitemap the last time somebody was adding footer links to one.
     */
    it.each(["/login", "/profile", "/logout"])(
      "leaves the noindex page %s out",
      async (url) => {
        seedMocks();

        const response = await request(server).get("/sitemap-1.xml");

        expect(response.text).not.toContain(
          `<loc>https://oldschoolgames.eu${url}</loc>`,
        );
      },
    );

    // Letters and genres are enumerated from the alphabet and the enum, not
    // from the catalogue, so the ones holding nothing used to be advertised —
    // and those addresses answer 404 now.
    it("leaves out letters and genres that hold no games", async () => {
      seedMocks();
      vi.mocked(Game.getSitemapCounts).mockResolvedValue({
        counts: new Map([
          ["letter:t", 1],
          ["genre:ACTION", 1],
        ]),
        lastmods: new Map(),
      });

      const response = await request(server).get("/sitemap-1.xml");

      expect(response.text).toContain(
        "<loc>https://oldschoolgames.eu/letter/t</loc>",
      );
      expect(response.text).toContain(
        "<loc>https://oldschoolgames.eu/action</loc>",
      );
      expect(response.text).not.toContain(
        "<loc>https://oldschoolgames.eu/letter/q</loc>",
      );
    });

    it("leaves out every genre when the catalogue is empty", async () => {
      seedMocks();
      vi.mocked(Game.getSitemapCounts).mockResolvedValue(emptySitemapCounts());

      const response = await request(server).get("/sitemap-1.xml");

      expect(response.text).not.toContain(
        "<loc>https://oldschoolgames.eu/action</loc>",
      );
      expect(response.text).not.toContain("/letter/");
    });

    // The curated lists were added unconditionally, and each
    // "best-<genre>-games" list is one genre — so a genre holding nothing was
    // named here while routes/lists.ts answers 404 for it.
    it("leaves out curated lists that hold no games", async () => {
      seedMocks();
      vi.mocked(Game.getSitemapCounts).mockResolvedValue({
        counts: new Map([["genre:SHOOTER", 1]]),
        lastmods: new Map(),
      });

      const response = await request(server).get("/sitemap-1.xml");

      expect(response.text).toContain(
        "<loc>https://oldschoolgames.eu/best-shooter-games</loc>",
      );
      expect(response.text).not.toContain(
        "<loc>https://oldschoolgames.eu/best-horror-games</loc>",
      );
    });

    it("keeps naming the lists index, which stands whatever they hold", async () => {
      seedMocks();
      vi.mocked(Game.count).mockResolvedValue(0);
      vi.mocked(Game.getSitemapCounts).mockResolvedValue(emptySitemapCounts());

      const response = await request(server).get("/sitemap-1.xml");

      expect(response.text).toContain(
        "<loc>https://oldschoolgames.eu/game-lists</loc>",
      );
      // The unfiltered list is the whole catalogue, so an empty one drops it.
      expect(response.text).not.toContain(
        "<loc>https://oldschoolgames.eu/top-dos-games</loc>",
      );
    });

    // The cache used to be a plain variable assigned only once a build had
    // finished, so two crawlers arriving on a cold cache each ran the whole
    // thing. TtlCache stores the in-flight promise instead.
    it("builds once when two requests arrive on a cold cache", async () => {
      seedMocks();

      const [first, second] = await Promise.all([
        request(server).get("/sitemap-index.xml"),
        request(server).get("/sitemap-1.xml"),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(Game.findForSitemap).toHaveBeenCalledTimes(1);
      expect(Game.getSitemapCounts).toHaveBeenCalledTimes(1);
    });

    it("falls through for a chunk that does not exist", async () => {
      seedMocks();

      const response = await request(server).get("/sitemap-99.xml");

      expect(response.status).toBe(404);
    });

    it.each(["/sitemap-abc.xml", "/sitemap-0.xml", "/sitemap--1.xml"])(
      "falls through for a malformed chunk number (%s)",
      async (path) => {
        seedMocks();

        const response = await request(server).get(path);

        expect(response.status).toBe(404);
      },
    );

    it("reports a generation failure without leaking the error", async () => {
      const error = new Error("Database error");
      vi.mocked(Game.count).mockRejectedValue(error);
      vi.mocked(Game.findForSitemap).mockRejectedValue(error);
      vi.mocked(Game.getGenres).mockRejectedValue(error);
      vi.mocked(Game.getDevelopers).mockRejectedValue(error);
      vi.mocked(Game.getPublishers).mockRejectedValue(error);
      vi.mocked(Game.getYears).mockRejectedValue(error);
      vi.mocked(Game.getSitemapCounts).mockRejectedValue(error);

      const response = await request(server).get("/sitemap-1.xml");

      expect(response.status).toBe(500);
      expect(response.text).toBe("Sitemap temporarily unavailable");
      expect(response.headers["cache-control"]).toBe("no-store");
    });
  });

  // Served from a route rather than public/, because the Sitemap line has to
  // name the host the site is running on. As a static file it carried a
  // hard-coded oldschoolgames.eu, so a deployment setting CANONICAL_HOST
  // pointed crawlers at somebody else's sitemap.
  describe("GET /robots.txt", () => {
    it("serves plain text naming the sitemap on the canonical host", async () => {
      const response = await request(server).get("/robots.txt");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.text).toContain(
        "Sitemap: https://oldschoolgames.eu/sitemap-index.xml",
      );
    });

    it("keeps the admin surface out of the crawl", async () => {
      const response = await request(server).get("/robots.txt");

      expect(response.text).toContain("Disallow: /games/new");
      expect(response.text).toContain("Disallow: /games/*/edit");
      expect(response.text).toContain("Disallow: /news/new");
      expect(response.text).toContain("Disallow: /news/*/edit");
    });

    /**
     * The same contradiction as the search URLs below, and a worse case of
     * it: views/footer.ejs links both of these from every page on the site,
     * so they are exactly the "blocked but linked to" URLs Google indexes
     * from the links alone — while the block keeps the tag that forbids it
     * out of reach. Both carry a noindex now (routes/auth.ts, routes/home.ts)
     * and neither is blocked, so the reliable half is the half that speaks.
     */
    it.each(["/login", "/profile"])(
      "does not block %s, which noindex already covers",
      async (path) => {
        const response = await request(server).get("/robots.txt");

        expect(response.text).not.toContain(`Disallow: ${path}`);
      },
    );

    // A link in the navbar on every page, answering every request with a 302
    // to a different game. Nothing there is worth crawling twice.
    it("keeps the random redirect out of the crawl", async () => {
      const response = await request(server).get("/robots.txt");

      expect(response.text).toContain("Disallow: /random");
    });

    /**
     * Disallow and noindex do not stack — they contradict. A search result is
     * already "noindex, follow" (views/head.ejs), and a page that is never
     * crawled is a page whose noindex is never read: a blocked URL can still
     * be indexed from its inbound links, precisely because the tag saying not
     * to is behind the block. Keeping the reliable half is the resolution, and
     * it costs no crawl budget — a search URL comes from submitting a form, so
     * nothing on the site links to one.
     */
    /**
     * What a crawler actually concludes, rather than which lines are present.
     *
     * A Disallow rule is a prefix, so the list above used to block real
     * content that merely *started* like an admin address: every article
     * titled "New …" (/news/new-games-added — the suite's own fixture), the
     * /news/news fallback slug, and /random-2, where a game titled "Random"
     * is filed because the bare slug belongs to the route. All of them are in
     * the sitemap, which Search Console reports as "Submitted URL blocked by
     * robots.txt". Matched here the way RFC 9309 describes: "*" is any run of
     * characters, a trailing "$" anchors the end, the longest matching rule
     * wins, and a tie goes to Allow.
     */
    describe("as a crawler reads it", () => {
      function allowed(robots: string, path: string): boolean {
        const rules = robots
          .split("\n")
          .map((line) => /^(Allow|Disallow):\s*(\S*)\s*$/i.exec(line.trim()))
          .filter((match): match is RegExpExecArray => match !== null)
          .map(([, kind, pattern]) => ({
            allow: kind.toLowerCase() === "allow",
            pattern,
            regex: new RegExp(
              "^" +
                pattern
                  .replace(/\$$/, "")
                  .replace(/[.+?^{}()|[\]\\]/g, "\\$&")
                  .replace(/\*/g, ".*") +
                (pattern.endsWith("$") ? "$" : ""),
            ),
          }));

        const matching = rules.filter((rule) => rule.regex.test(path));

        if (matching.length === 0) return true;

        const longest = Math.max(...matching.map((rule) => rule.pattern.length));

        return matching.some(
          (rule) => rule.pattern.length === longest && rule.allow,
        );
      }

      it.each([
        "/logout",
        "/random",
        "/random?not=12",
        "/games/new",
        "/games/12/edit",
        "/news/new",
        "/news/3/edit",
      ])("keeps %s out of the crawl", async (path) => {
        const response = await request(server).get("/robots.txt");

        expect(allowed(response.text, path)).toBe(false);
      });

      it.each([
        "/news/new-games-added",
        "/news/news",
        "/news/newsletter-2",
        "/random-2",
        "/randomizer",
        "/logout-screen",
        "/",
        "/doom",
      ])("lets %s be crawled", async (path) => {
        const response = await request(server).get("/robots.txt");

        expect(allowed(response.text, path)).toBe(true);
      });
    });

    it("does not block the search URLs that noindex already covers", async () => {
      const response = await request(server).get("/robots.txt");

      expect(response.text).not.toContain("search=");
    });

    it("costs no database access", async () => {
      seedMocks();
      vi.clearAllMocks();

      await request(server).get("/robots.txt");

      expect(Game.findForSitemap).not.toHaveBeenCalled();
      expect(Game.getSitemapCounts).not.toHaveBeenCalled();
    });

    /**
     * The trap that makes every exclusion above conditional.
     *
     * robots.txt matching is not additive: a crawler obeys the single most
     * specific group that names it and ignores every other one, "*" included.
     * So the day somebody adds "User-agent: GPTBot" to state a policy for the
     * AI crawlers — the decision the comment on ROBOTS_TXT records, and the
     * likeliest future edit to this file — that agent stops reading the "*"
     * group and is turned loose on /random and the admin forms, which is the
     * opposite of what such an edit is ever trying to do.
     *
     * Not a ban on naming an agent. Every group simply has to carry the
     * exclusions itself, which is what makes a named group safe.
     */
    it("repeats the exclusions in every user-agent group it declares", async () => {
      const response = await request(server).get("/robots.txt");

      // Split on the User-agent lines, keeping each as the head of its block.
      const groups = response.text
        .split(/^(?=User-agent:)/m)
        .map((block) => block.trim())
        .filter(Boolean);

      expect(groups.length).toBeGreaterThan(0);

      const required = [
        "Disallow: /logout$",
        "Disallow: /random$",
        "Disallow: /random?",
        "Disallow: /games/new$",
        "Disallow: /games/*/edit$",
        "Disallow: /news/new$",
        "Disallow: /news/*/edit$",
      ];

      for (const group of groups) {
        const agent = /User-agent:\s*(\S+)/.exec(group)?.[1];

        // A group that shuts an agent out entirely needs no itemised list.
        if (/^Disallow:\s*\/\s*$/m.test(group)) continue;

        for (const rule of required) {
          expect(group, `${agent} is missing "${rule}"`).toContain(rule);
        }
      }
    });
  });

  /**
   * robots.txt names /sitemap-index.xml and Search Console has that address
   * registered, so it stays the one document — but /sitemap.xml is where a
   * crawler looks before it has read robots.txt, and where a person types
   * first. A redirect rather than a second copy: one sitemap, one address.
   */
  describe("GET /sitemap.xml", () => {
    it("redirects permanently to the sitemap index", async () => {
      const response = await request(server).get("/sitemap.xml");

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe(
        "https://oldschoolgames.eu/sitemap-index.xml",
      );
    });

    it("costs no database access", async () => {
      seedMocks();
      vi.clearAllMocks();

      await request(server).get("/sitemap.xml");

      expect(Game.findForSitemap).not.toHaveBeenCalled();
      expect(Game.getSitemapCounts).not.toHaveBeenCalled();
    });
  });

  /**
   * Same reasoning as the feed's own well-formedness suite: a control
   * character has no XML representation at all, so escaping the markup
   * characters and stopping there let one bad value cost the whole document.
   * A sitemap a crawler cannot parse is a sitemap that indexes nothing.
   */
  describe("well-formedness", () => {
    function parses(xml: string): boolean {
      const { window } = new JSDOM("");
      const doc = new window.DOMParser().parseFromString(xml, "text/xml");

      return doc.querySelector("parsererror") === null;
    }

    // A developer or publisher name goes into the URL of its own listing
    // page, and those are free text on the admin form.
    it("stays parseable when a developer name holds a control character", async () => {
      seedMocks();
      vi.mocked(Game.getDevelopers).mockResolvedValue([
        `id${String.fromCharCode(1)} Software`,
      ] as any);
      clearSitemapCache();

      const index = await request(server).get("/sitemap-index.xml");
      const chunk = await request(server).get("/sitemap-1.xml");

      expect(parses(index.text)).toBe(true);
      expect(chunk.status).toBe(200);
      expect(parses(chunk.text)).toBe(true);
    });

    it("stays parseable when a slug holds a lone surrogate", async () => {
      seedMocks();
      vi.mocked(Game.findForSitemap).mockResolvedValue([
        { slug: "doom\uD800", updatedAt: new Date("2025-06-01") },
      ] as any);
      clearSitemapCache();

      const chunk = await request(server).get("/sitemap-1.xml");

      expect(chunk.status).toBe(200);
      expect(parses(chunk.text)).toBe(true);
    });
  });

  /**
   * The Google image sitemap extension.
   *
   * Every game page carries a cover and a run of screenshots, and none of it
   * was submitted anywhere — the one part of this catalogue that is purely
   * visual had no route into image search but an ordinary crawl.
   */
  describe("image extension", () => {
    function parses(xml: string): boolean {
      const { window } = new JSDOM("");
      const doc = new window.DOMParser().parseFromString(xml, "text/xml");

      return doc.querySelector("parsererror") === null;
    }

    it("submits a game's artwork under its own URL", async () => {
      seedMocks();
      vi.mocked(Game.findForSitemap).mockResolvedValue([
        {
          slug: "doom",
          updatedAt: new Date("2025-06-01"),
          images: [
            "https://media.example/doom-cover.png",
            "https://media.example/doom-1.png",
          ],
        },
      ] as any);
      clearSitemapCache();

      const chunk = await request(server).get("/sitemap-1.xml");

      expect(chunk.status).toBe(200);
      expect(parses(chunk.text)).toBe(true);
      expect(chunk.text).toContain(
        'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"',
      );
      expect(chunk.text).toContain(
        "<image:loc>https://media.example/doom-cover.png</image:loc>",
      );
      expect(chunk.text).toContain(
        "<image:loc>https://media.example/doom-1.png</image:loc>",
      );

      // Inside the <url> the images belong to, not loose in the document.
      const url = /<url>\s*<loc>[^<]*\/doom<\/loc>[\s\S]*?<\/url>/.exec(
        chunk.text,
      )?.[0];

      expect(url).toBeDefined();
      expect(url).toContain("<image:image>");
    });

    it("declares no image namespace when there is no artwork", async () => {
      seedMocks();
      vi.mocked(Game.findForSitemap).mockResolvedValue([
        { slug: "doom", updatedAt: new Date("2025-06-01"), images: [] },
      ] as any);
      clearSitemapCache();

      const chunk = await request(server).get("/sitemap-1.xml");

      expect(chunk.status).toBe(200);
      expect(chunk.text).not.toContain("xmlns:image");
      expect(chunk.text).not.toContain("<image:image>");
    });

    // A game whose first slot was left blank holds "" there — the same empty
    // string that once reached og:image and the /collection JSON as a real
    // address. An <image:loc></image:loc> would resolve to the page itself.
    it("drops blank image slots rather than publishing them", async () => {
      seedMocks();
      vi.mocked(Game.findForSitemap).mockResolvedValue([
        {
          slug: "doom",
          updatedAt: new Date("2025-06-01"),
          images: ["", "https://media.example/doom-1.png"],
        },
      ] as any);
      clearSitemapCache();

      const chunk = await request(server).get("/sitemap-1.xml");

      expect(chunk.status).toBe(200);
      expect(chunk.text).not.toContain("<image:loc></image:loc>");
      expect([...chunk.text.matchAll(/<image:loc>/g)].length).toBe(1);
    });

    it("makes a relative image path absolute", async () => {
      seedMocks();
      vi.mocked(Game.findForSitemap).mockResolvedValue([
        {
          slug: "doom",
          updatedAt: new Date("2025-06-01"),
          images: ["/images/doom.png"],
        },
      ] as any);
      clearSitemapCache();

      const chunk = await request(server).get("/sitemap-1.xml");

      expect(chunk.status).toBe(200);
      expect(chunk.text).toContain(
        "<image:loc>https://oldschoolgames.eu/images/doom.png</image:loc>",
      );
    });

    /**
     * <image:loc> was SITE_URL + image, which is right for exactly one shape:
     * a path that starts with "/" and needs no encoding. absoluteUrl() is what
     * the page's own JSON-LD resolves the same artwork with, so the two now
     * name one address for one picture.
     */
    it("resolves an image path the way the page does, not by concatenation", async () => {
      seedMocks();
      vi.mocked(Game.findForSitemap).mockResolvedValue([
        {
          slug: "doom",
          updatedAt: new Date("2025-06-01"),
          images: [
            // Stored before the validator refused a path with no leading
            // slash, and concatenated into "https://oldschoolgames.euimages/…".
            "images/doom.png",
            // A space, which concatenation published as it stood.
            "/images/doom 2.png",
          ],
        },
      ] as any);
      clearSitemapCache();

      const chunk = await request(server).get("/sitemap-1.xml");

      expect(chunk.status).toBe(200);
      expect(chunk.text).not.toContain("oldschoolgames.euimages");
      expect(chunk.text).toContain(
        "<image:loc>https://oldschoolgames.eu/images/doom.png</image:loc>",
      );
      expect(chunk.text).toContain(
        "<image:loc>https://oldschoolgames.eu/images/doom%202.png</image:loc>",
      );
    });

    // <image:loc> takes an http(s) address; anything that does not resolve to
    // one is left out rather than published as an image of the site.
    it("leaves out an image that does not resolve to an http(s) address", async () => {
      seedMocks();
      vi.mocked(Game.findForSitemap).mockResolvedValue([
        {
          slug: "doom",
          updatedAt: new Date("2025-06-01"),
          images: ["data:image/png;base64,AAAA", "https://media.example/doom.png"],
        },
      ] as any);
      clearSitemapCache();

      const chunk = await request(server).get("/sitemap-1.xml");

      expect(chunk.text).not.toContain("data:image");
      expect([...chunk.text.matchAll(/<image:loc>/g)].length).toBe(1);
    });

    // Image URLs come out of the same admin form every other free-text field
    // does, so they get the same treatment the slugs and developer names in
    // the block above do.
    it("stays parseable when an image URL holds an ampersand", async () => {
      seedMocks();
      vi.mocked(Game.findForSitemap).mockResolvedValue([
        {
          slug: "doom",
          updatedAt: new Date("2025-06-01"),
          images: ["https://media.example/doom.png?a=1&b=2"],
        },
      ] as any);
      clearSitemapCache();

      const chunk = await request(server).get("/sitemap-1.xml");

      expect(chunk.status).toBe(200);
      expect(parses(chunk.text)).toBe(true);
      expect(chunk.text).toContain("a=1&amp;b=2");
    });

    // findForSitemap is the only caller and always selects the column, but the
    // suite mocks it in a dozen places without one and the live rows predate
    // the change — an entry with no images array must simply carry no tags.
    it("tolerates a row with no images at all", async () => {
      seedMocks();
      clearSitemapCache();

      const chunk = await request(server).get("/sitemap-1.xml");

      expect(chunk.status).toBe(200);
      expect(parses(chunk.text)).toBe(true);
    });
  });

  /**
   * Both elements are gone from this document, and this is what keeps them
   * gone: they cost nothing to write, so the temptation to put one back on a
   * new entry "for completeness" is exactly the kind of thing a test has to
   * refuse. See the comment on SitemapEntry for why neither is read by
   * anything the site is submitted to.
   */
  describe("changefreq and priority", () => {
    it("appear nowhere in the document", async () => {
      seedMocks();
      clearSitemapCache();

      const chunk = await request(server).get("/sitemap-1.xml");

      expect(chunk.status).toBe(200);
      expect(chunk.text).not.toContain("<changefreq>");
      expect(chunk.text).not.toContain("<priority>");
    });
  });

  /**
   * Every listing URL in this document used to carry a changefreq and a
   * priority and nothing else — and Google ignores both of those outright, so
   * several hundred addresses offered no freshness signal at all. The date
   * comes off the same GROUP BY the counts do; see Game.getSitemapCounts.
   */
  describe("lastmod on the listing pages", () => {
    it("dates a genre, letter, developer, publisher and year page", async () => {
      seedMocks();
      vi.mocked(Game.getSitemapCounts).mockResolvedValue({
        counts: new Map([
          ["letter:d", 1],
          ["genre:SHOOTER", 1],
          ["developer:id Software", 1],
          ["publisher:id Software", 1],
          ["year:1993", 1],
        ]),
        lastmods: new Map([
          ["letter:d", "2024-03-04T10:00:00.000Z"],
          ["genre:SHOOTER", "2024-03-05T10:00:00.000Z"],
          ["developer:id Software", "2024-03-06T10:00:00.000Z"],
          ["publisher:id Software", "2024-03-07T10:00:00.000Z"],
          ["year:1993", "2024-03-08T10:00:00.000Z"],
        ]),
      });
      vi.mocked(Game.getGenres).mockResolvedValue(["SHOOTER"] as any);
      vi.mocked(Game.getDevelopers).mockResolvedValue(["id Software"]);
      vi.mocked(Game.getPublishers).mockResolvedValue(["id Software"]);
      vi.mocked(Game.getYears).mockResolvedValue([1993]);

      const { text } = await request(server).get("/sitemap-1.xml");

      const entry = (loc: string) => {
        const at = text.indexOf(`<loc>https://oldschoolgames.eu${loc}</loc>`);
        expect(at, `${loc} is missing`).toBeGreaterThan(-1);
        return text.slice(at, text.indexOf("</url>", at));
      };

      expect(entry("/letter/d")).toContain("<lastmod>2024-03-04</lastmod>");
      expect(entry("/shooter")).toContain("<lastmod>2024-03-05</lastmod>");
      expect(entry("/developer/id%20Software")).toContain(
        "<lastmod>2024-03-06</lastmod>",
      );
      expect(entry("/publisher/id%20Software")).toContain(
        "<lastmod>2024-03-07</lastmod>",
      );
      expect(entry("/year/1993")).toContain("<lastmod>2024-03-08</lastmod>");
    });

    /**
     * The home page stands over both the catalogue and the news, so it is
     * dated by whichever changed last — and by either on its own. It used
     * to consult the news only when there was also a dated game, so a
     * catalogue with no dated game and fresh news shipped it undated.
     */
    it("dates the home page from the news alone when no game is dated", async () => {
      seedMocks();
      vi.mocked(Game.findForSitemap).mockResolvedValue([
        { slug: "test-game", updatedAt: null },
      ] as any);
      // News is not mocked module-wide — other cases read the real table —
      // so it is stubbed here and put back.
      const news = vi.spyOn(News, "findForSitemap").mockResolvedValue([
        { id: 1, slug: "fresh-news", updatedAt: new Date("2024-05-06T10:00:00Z") },
      ]);

      try {
        const { text } = await request(server).get("/sitemap-1.xml");

        const at = text.indexOf("<loc>https://oldschoolgames.eu/</loc>");
        expect(at).toBeGreaterThan(-1);
        expect(text.slice(at, text.indexOf("</url>", at))).toContain(
          "<lastmod>2024-05-06</lastmod>",
        );
      } finally {
        news.mockRestore();
      }
    });

    it("dates the home page by the later of the newest game and the newest news", async () => {
      seedMocks();
      vi.mocked(Game.findForSitemap).mockResolvedValue([
        { slug: "test-game", updatedAt: new Date("2024-05-01T10:00:00Z") },
      ] as any);
      const news = vi.spyOn(News, "findForSitemap").mockResolvedValue([
        { id: 1, slug: "fresh-news", updatedAt: new Date("2024-05-09T10:00:00Z") },
      ]);

      try {
        const { text } = await request(server).get("/sitemap-1.xml");

        const at = text.indexOf("<loc>https://oldschoolgames.eu/</loc>");
        expect(text.slice(at, text.indexOf("</url>", at))).toContain(
          "<lastmod>2024-05-09</lastmod>",
        );
      } finally {
        news.mockRestore();
      }
    });

    /**
     * The value at hand is the newest game in a group, which describes the
     * front of a listing and not page seven of it. Google leans on lastmod
     * only while it is consistently accurate, so the deep pages say nothing.
     */
    it("leaves the deeper pages of a listing undated", async () => {
      seedMocks();
      vi.mocked(Game.getSitemapCounts).mockResolvedValue({
        counts: new Map([["genre:SHOOTER", 60]]),
        lastmods: new Map([["genre:SHOOTER", "2024-03-05T10:00:00.000Z"]]),
      });
      vi.mocked(Game.getGenres).mockResolvedValue(["SHOOTER"] as any);

      const { text } = await request(server).get("/sitemap-1.xml");

      const at = text.indexOf(
        "<loc>https://oldschoolgames.eu/shooter?page=2</loc>",
      );
      expect(at).toBeGreaterThan(-1);
      expect(text.slice(at, text.indexOf("</url>", at))).not.toContain(
        "<lastmod>",
      );
    });

    /**
     * A curated list is one URL now — LIST_SIZE in routes/lists.ts caps it at
     * a hundred games on a single page, and the route 301s the old ?page=
     * addresses onto it. Naming them here would advertise a redirect.
     */
    it("names a curated list once, with no ?page= children", async () => {
      seedMocks();
      vi.mocked(Game.getSitemapCounts).mockResolvedValue({
        counts: new Map([["genre:SHOOTER", 500]]),
        lastmods: new Map([["genre:SHOOTER", "2024-03-05T10:00:00.000Z"]]),
      });

      const { text } = await request(server).get("/sitemap-1.xml");

      const at = text.indexOf(
        "<loc>https://oldschoolgames.eu/best-shooter-games</loc>",
      );
      expect(at).toBeGreaterThan(-1);
      expect(text).not.toContain("/best-shooter-games?page=");
    });

    /**
     * A ranking moves with every play and every vote, and neither touches
     * "games"."updatedAt" — the 0042 trigger writes the rating totals and
     * nothing else, and a play writes no game row at all. So these pages were
     * stamped with the date somebody last edited a game while their order
     * changed underneath it: a lastmod that never moves on a page that does,
     * which is exactly what teaches Google to stop trusting the site's
     * lastmods — the ones on the game pages included. They say nothing now,
     * as /comments already did.
     */
    it("leaves the rankings undated, by plays and by rating alike", async () => {
      seedMocks();
      vi.mocked(Game.getSitemapCounts).mockResolvedValue({
        counts: new Map([
          ["genre:SHOOTER", 3],
          ["year:1993", 3],
        ]),
        lastmods: new Map([
          ["genre:SHOOTER", "2024-03-05T10:00:00.000Z"],
          ["year:1993", "2024-03-06T10:00:00.000Z"],
        ]),
      });
      vi.mocked(Game.getGenres).mockResolvedValue(["SHOOTER"] as any);
      vi.mocked(Game.getYears).mockResolvedValue([1993]);

      const { text } = await request(server).get("/sitemap-1.xml");

      const entry = (loc: string) => {
        const at = text.indexOf(`<loc>https://oldschoolgames.eu${loc}</loc>`);
        expect(at, `${loc} is missing`).toBeGreaterThan(-1);
        return text.slice(at, text.indexOf("</url>", at));
      };

      for (const ranking of [
        "/most-played",
        "/top-dos-games",
        "/best-shooter-games",
        "/dos-games-1990s",
      ]) {
        expect(entry(ranking), ranking).not.toContain("<lastmod>");
      }

      // The listings whose content is the games themselves keep theirs.
      expect(entry("/shooter")).toContain("<lastmod>2024-03-05</lastmod>");
      expect(entry("/year/1993")).toContain("<lastmod>2024-03-06</lastmod>");
      expect(entry("/developers")).toContain("<lastmod>2025-06-01</lastmod>");
    });
  });
});
