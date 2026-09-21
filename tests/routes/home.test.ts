import { beforeEach, describe, expect, it, vi, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import homeRouter from "../../routes/home.ts";
import Game from "../../models/game.ts";
import Comment from "../../models/comment.ts";
import GameOfTheWeek from "../../models/game-of-the-week.ts";
import News from "../../models/news.ts";
import {
  LD_TEXT_MAX,
  META_DESCRIPTION_MAX,
  TITLE_MAX,
  htmlToPlainText,
} from "../../utils/html-text.ts";

vi.mock("../../models/game", () => ({
  default: {
    find: vi.fn(),
    count: vi.fn(),
    getGenres: vi.fn(),
    getDevelopers: vi.fn(),
    getPublishers: vi.fn(),
    getYears: vi.fn(),
    findById: vi.fn(),
    findBySlug: vi.fn(),
    findCurrentSlug: vi.fn(),
    findSimilar: vi.fn(),
    findAdjacentGames: vi.fn(),
    findFeatured: vi.fn(),
    findRandom: vi.fn(),
    findTitleSuggestions: vi.fn(),
    getVoterRating: vi.fn(),
  },
}));

vi.mock("../../models/comment", () => ({
  default: {
    findByGameId: vi.fn(),
    countAll: vi.fn(),
    countRoots: vi.fn(),
  },
}));

vi.mock("../../models/news", () => ({
  default: {
    findRecent: vi.fn(),
  },
}));

vi.mock("../../models/game-of-the-week", () => ({
  default: {
    getCurrent: vi.fn(),
    selectNewGameOfTheWeek: vi.fn(),
  },
}));

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.render = vi.fn((view, data) => {
    res.json({ view, data });
  });
  next();
});

app.use("/", homeRouter);

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

describe("Home Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for News.findRecent
    vi.mocked(News.findRecent).mockResolvedValue([]);
    // Default mock for Game.findFeatured
    vi.mocked(Game.findFeatured).mockResolvedValue([]);
    // Listing routes report a total alongside the page of results
    vi.mocked(Game.count).mockResolvedValue(0);
    vi.mocked(Game.findTitleSuggestions).mockResolvedValue([]);
    vi.mocked(Game.getVoterRating).mockResolvedValue(null);
    // No renamed game claims the address unless a test says otherwise.
    vi.mocked(Game.findCurrentSlug).mockResolvedValue(null);
    vi.mocked(Comment.countAll).mockResolvedValue(0);
    vi.mocked(Comment.countRoots).mockResolvedValue(0);
  });

  describe("GET /", () => {
    it("should render index page", async () => {
      const mockGames = [{ id: 1, title: "Test Game 1", genre: "ACTION" }];
      const mockNews = [{ id: 1, title: "Test News", content: "Test content" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue({ id: 1 } as any);
      vi.mocked(News.findRecent).mockResolvedValue(mockNews as any);

      const response = await request(server).get("/");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("index");
      expect(response.body.data.games).toEqual(mockGames);
    });

    /**
     * The homepage teaser used to be the whole article.
     *
     * views/news/news-preview.ejs rendered `content` raw and clamped it to
     * three lines in CSS, so every visitor downloaded and parsed three
     * complete articles to read about thirty words of them — and a screen
     * reader, which does not honour a line clamp, read all three out in
     * full. The route hands the view a plain-text excerpt instead.
     */
    it("hands the news preview an excerpt, not the article", async () => {
      const content =
        "<p>" +
        "The id Software team shipped it in 1993. ".repeat(20) +
        "</p>";

      vi.mocked(Game.find).mockResolvedValue([]);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue(null);
      vi.mocked(News.findRecent).mockResolvedValue([
        { id: 1, title: "Doom turns 30", slug: "doom-30", content },
      ] as any);

      const [item] = (await request(server).get("/")).body.data.recentNews;

      expect(item.excerpt).not.toContain("<p>");
      expect(item.excerpt.length).toBeLessThan(260);
      expect(item.excerpt.endsWith("\u2026")).toBe(true);
      // Cut on a word boundary, not mid-word.
      expect(content).toContain(item.excerpt.replace("\u2026", "").trim());
    });

    it("leaves a short article whole and unmarked", async () => {
      vi.mocked(Game.find).mockResolvedValue([]);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue(null);
      vi.mocked(News.findRecent).mockResolvedValue([
        { id: 1, title: "Short", slug: "short", content: "<p>Two words</p>" },
      ] as any);

      const [item] = (await request(server).get("/")).body.data.recentNews;

      expect(item.excerpt).toBe("Two words");
    });

    it("should render index page when game of the week is not set", async () => {
      const mockGames = [{ id: 1, title: "Test Game 1" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue(null);

      const response = await request(server).get("/");

      expect(response.status).toBe(200);
    });

    /**
     * views/head.ejs renders nextPageUrl as <link rel="next">, and
     * views/pagination.ejs decides the visible Next button from `total`. The
     * two used to disagree: the route derived nextPageUrl from whether the
     * page came back full, so a catalogue of exactly one page's worth pointed
     * crawlers at ?page=2 — which this same route answers with a 404.
     */
    it("advertises no next page when the catalogue is exactly one page", async () => {
      const mockGames = Array.from({ length: 25 }, (_, index) => ({
        id: index + 1,
        title: `Game ${index + 1}`,
      }));

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.count).mockResolvedValue(25);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue(null);

      const response = await request(server).get("/");

      expect(response.status).toBe(200);
      expect(response.body.data.nextPageUrl).toBeUndefined();
    });

    it("advertises a next page while games remain", async () => {
      const mockGames = Array.from({ length: 25 }, (_, index) => ({
        id: index + 1,
        title: `Game ${index + 1}`,
      }));

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.count).mockResolvedValue(26);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue(null);

      const response = await request(server).get("/");

      expect(response.body.data.nextPageUrl).toContain("?page=2");
    });

    it("should redirect to genre page when genre query param is provided", async () => {
      const response = await request(server).get("/?genre=ACTION");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/action");
    });

    // The genre lands in a Location header. "/evil.example.com" used to build
    // "//evil.example.com", which a browser reads as a protocol-relative URL —
    // the site's own address handing visitors to someone else.
    it("keeps the genre redirect on this site", async () => {
      for (const genre of [
        "/evil.example.com",
        "//evil.example.com",
        "\\evil.example.com",
        "../../etc",
        "https://evil.example.com",
      ]) {
        const response = await request(server).get(
          `/?genre=${encodeURIComponent(genre)}`,
        );

        expect(response.status).toBe(302);
        expect(response.headers.location.startsWith("/")).toBe(true);
        expect(response.headers.location.slice(1)).not.toMatch(/^[/\\]/);
      }
    });

    // "?genre=a&genre=b" arrives as an array, and reaching for a string method
    // on it threw — a 500 for what is only a malformed URL.
    it("survives a repeated genre key", async () => {
      const response = await request(server).get("/?genre=a&genre=b");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/a");
    });

    it("survives a repeated search key", async () => {
      vi.mocked(Game.find).mockResolvedValue([] as any);
      vi.mocked(Game.count).mockResolvedValue(0);
      vi.mocked(Game.findTitleSuggestions).mockResolvedValue([] as any);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue(null);

      const response = await request(server).get("/?search=a&search=b");

      expect(response.status).toBe(200);
      expect(Game.find).toHaveBeenCalledWith(
        expect.objectContaining({ search: "a" }),
      );
    });

    it("should handle search query parameter", async () => {
      const mockGames = [{ id: 1, title: "Test Game" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue({ id: 1 } as any);

      const response = await request(server).get("/?search=test");

      expect(Game.find).toHaveBeenCalledWith({
        search: "test",
        page: 1,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
    });

    // A 400, not a 404: the page exists, the request for it was malformed.
    it("should reject search query longer than 100 characters", async () => {
      const longSearch = "a".repeat(101);
      const response = await request(server).get(`/?search=${longSearch}`);

      expect(response.status).toBe(400);
    });

    /**
     * og:url on a set of search results, which used to name the home page.
     *
     * The canonical for a results page deliberately points at the unfiltered
     * listing — a search is "noindex, follow" and a slice of that listing
     * rather than a page in its own right — and views/index.ejs falls back to
     * the canonical whenever no ogUrl is given. So the one tag whose entire
     * job is to name what was shared named something else, and a search link
     * pasted into Slack, Facebook or Discord unfurled as the front page: its
     * title, its description, its address.
     */
    describe("og:url on a search", () => {
      beforeEach(() => {
        vi.mocked(Game.find).mockResolvedValue([
          { id: 1, title: "Doom" },
        ] as any);
        vi.mocked(Game.count).mockResolvedValue(1);
        vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue(null);
      });

      it("names the search address rather than the home page", async () => {
        const response = await request(server).get("/?search=doom");

        expect(response.body.data.ogUrl).toBe(
          "https://oldschoolgames.eu/?search=doom",
        );
      });

      // The other half of the same decision: naming the results page here must
      // not quietly turn it into a page that asks to be indexed.
      it("leaves the canonical pointing at the unfiltered listing", async () => {
        const response = await request(server).get("/?search=doom");

        expect(response.body.data.canonicalUrl).toBe(
          "https://oldschoolgames.eu/",
        );
      });

      it("encodes a term that would otherwise break the address", async () => {
        const response = await request(server).get(
          `/?search=${encodeURIComponent("a&b c")}`,
        );

        expect(response.body.data.ogUrl).toBe(
          "https://oldschoolgames.eu/?search=a%26b%20c",
        );
      });

      it("carries the page number on a deeper page of results", async () => {
        vi.mocked(Game.count).mockResolvedValue(60);

        const response = await request(server).get("/?search=doom&page=2");

        expect(response.body.data.ogUrl).toBe(
          "https://oldschoolgames.eu/?search=doom&page=2",
        );
      });

      /**
       * Left undefined rather than set to the canonical, so the view's own
       * fallback goes on deciding for every page that is not a search. A
       * second place computing the same address is a second place for it to
       * drift away from the first.
       */
      it("is not set on an ordinary listing", async () => {
        const response = await request(server).get("/");

        expect(response.body.data.ogUrl).toBeUndefined();
      });
    });

    it("should handle valid orderBy and orderDir parameters", async () => {
      const mockGames = [{ id: 1, title: "Test Game" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue({ id: 1 } as any);

      const response = await request(server).get(
        "/?orderBy=rating&orderDir=DESC",
      );

      expect(Game.find).toHaveBeenCalledWith({
        search: undefined,
        page: 1,
        limit: 25,
        orderBy: "rating",
        orderDir: "DESC",
      });
      expect(response.status).toBe(200);
    });

    it("should reject invalid orderBy parameter", async () => {
      const response = await request(server).get("/?orderBy=invalid");

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderDir parameter", async () => {
      const response = await request(server).get("/?orderDir=INVALID");

      expect(response.status).toBe(404);
    });

    it("should handle pagination", async () => {
      const mockGames = [{ id: 1, title: "Test Game" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      // A total that reaches page 2. The listing query is only run for a page
      // the count says exists — see isPageBeyondTotal — so a catalogue of
      // nothing would make this a 404 rather than a paged request.
      vi.mocked(Game.count).mockResolvedValue(30);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue({ id: 1 } as any);

      const response = await request(server).get("/?page=2");

      expect(Game.find).toHaveBeenCalledWith({
        search: undefined,
        page: 2,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
    });

    it("should clamp invalid pagination to page 1", async () => {
      const mockGames = [{ id: 1, title: "Test Game" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue({ id: 1 } as any);

      const response = await request(server).get("/?page=-1");

      expect(Game.find).toHaveBeenCalledWith({
        search: undefined,
        page: 1,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
    });

    /**
     * A page past the end of the listing is refused from the count, before the
     * listing query runs at all.
     *
     * parsePageParam admits anything up to 10000, and the check used to be
     * "run the query, see no rows, 404" — so "?page=9999" aggregated the whole
     * filtered set and offset 249950 rows into it to discover an address that
     * does not exist. Ten thousand such addresses per listing, each reachable
     * from a link anybody can write.
     */
    it.each([
      ["/", () => undefined],
      ["/action", () => vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"])],
      ["/letter/a", () => undefined],
      ["/developer/id%20Software", () => undefined],
      ["/publisher/Apogee", () => undefined],
      ["/year/1993", () => undefined],
    ])("404s %s past the end without running the listing query", async (
      path,
      prepare,
    ) => {
      prepare();
      vi.mocked(Game.count).mockResolvedValue(30);
      vi.mocked(Game.getYears).mockResolvedValue([1993]);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue(null);

      const response = await request(server).get(`${path}?page=9999`);

      expect(response.status).toBe(404);
      expect(Game.find).not.toHaveBeenCalled();
    });

    // ...and the last page that does exist is still served, which is the line
    // the guard has to draw in the right place.
    it("still serves the last page that exists", async () => {
      vi.mocked(Game.count).mockResolvedValue(30);
      vi.mocked(Game.find).mockResolvedValue([{ id: 26 }] as any);
      vi.mocked(GameOfTheWeek.getCurrent).mockResolvedValue(null);

      const response = await request(server).get("/?page=2");

      expect(response.status).toBe(200);
      expect(Game.find).toHaveBeenCalled();
    });
  });

  describe("GET /:genre", () => {
    it("should render games for valid genre", async () => {
      const mockGames = [{ id: 1, title: "Action Game", genre: "ACTION" }];

      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION", "ADVENTURE"]);
      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.count).mockResolvedValue(1);

      const response = await request(server).get("/action");

      expect(Game.getGenres).toHaveBeenCalled();
      expect(Game.find).toHaveBeenCalledWith({
        genre: "action",
        page: 1,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("index");
      expect(response.body.data.genre).toBe("action");
    });

    it("should return 404 for invalid genre", async () => {
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION", "ADVENTURE"]);

      const response = await request(server).get("/invalid-genre");

      expect(response.status).toBe(404);
    });

    // The genre is in the enum, so it is a real address — but with nothing
    // filed under it the page was a 200 carrying its own <title>, canonical
    // and blurb around an empty list, which is an indexable page of nothing.
    it("returns 404 for a genre that holds no games", async () => {
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
      vi.mocked(Game.find).mockResolvedValue([]);
      vi.mocked(Game.count).mockResolvedValue(0);

      const response = await request(server).get("/action");

      expect(response.status).toBe(404);
    });

    it("should handle orderBy and orderDir for genre", async () => {
      const mockGames = [{ id: 1, title: "Action Game" }];

      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.count).mockResolvedValue(1);

      const response = await request(server).get(
        "/action?orderBy=title&orderDir=ASC",
      );

      expect(Game.find).toHaveBeenCalledWith({
        genre: "action",
        page: 1,
        limit: 25,
        orderBy: "title",
        orderDir: "ASC",
      });
      expect(response.status).toBe(200);
    });

    it("should reject invalid orderBy for genre", async () => {
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);

      const response = await request(server).get("/action?orderBy=invalid");

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderDir for genre", async () => {
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);

      const response = await request(server).get("/action?orderDir=INVALID");

      expect(response.status).toBe(404);
    });

    /**
     * The enum is upper case and the URLs are not, so the lookup has to ignore
     * case — which also meant "/ACTION" answered 200 with a second copy of
     * "/action". The canonical said where the page really lived; a 301 does
     * not depend on being read.
     */
    describe("upper case in the path", () => {
      beforeEach(() => {
        vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
      });

      it.each(["/ACTION", "/Action", "/aCtIoN"])(
        "301s %s onto the lower-case address",
        async (path) => {
          const response = await request(server).get(path);

          expect(response.status).toBe(301);
          expect(response.headers.location).toBe("/action");
        },
      );

      it("keeps the query string exactly as it arrived", async () => {
        const response = await request(server).get(
          "/ACTION?page=3&orderBy=title",
        );

        expect(response.status).toBe(301);
        expect(response.headers.location).toBe("/action?page=3&orderBy=title");
      });

      // The lower-case form is the destination, so it must not itself
      // redirect — that is the loop this whole rule could become.
      it("leaves the lower-case address alone", async () => {
        vi.mocked(Game.find).mockResolvedValue([{ id: 1 }] as any);
        vi.mocked(Game.count).mockResolvedValue(1);

        const response = await request(server).get("/action");

        expect(response.status).toBe(200);
      });

      // Relative, like every other redirect the site writes: the
      // canonical-host redirect is production-only, so an absolute Location
      // here would bounce a developer out to the live site.
      it("sends a relative Location that cannot leave the site", async () => {
        const response = await request(server).get("/ACTION");

        expect(response.headers.location.startsWith("/")).toBe(true);
        expect(response.headers.location.slice(1)).not.toMatch(/^[/\\]/);
      });

      // A genre the catalogue does not know is still a 404, not a redirect to
      // a lower-case 404.
      it("does not redirect a path that names no genre", async () => {
        const response = await request(server).get("/NOT-A-GENRE");

        expect(response.status).toBe(404);
      });
    });
  });

  describe("GET /letter/:letter", () => {
    it("should render games for valid letter", async () => {
      const mockGames = [{ id: 1, title: "Amazing Game" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.count).mockResolvedValue(1);

      const response = await request(server).get("/letter/a");

      expect(Game.find).toHaveBeenCalledWith({
        letter: "a",
        page: 1,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("index");
      expect(response.body.data.letter).toBe("a");
      expect(response.body.data.title).toContain("'A'");
      expect(response.body.data.canonicalUrl).toBe(
        "https://oldschoolgames.eu/letter/a",
      );
    });

    it("should return 404 for invalid letter", async () => {
      const response = await request(server).get("/letter/123");

      expect(response.status).toBe(404);
    });

    // All 26 are linked from the alphabet filter, so on a catalogue with gaps
    // this was a standing supply of empty indexable pages.
    it("returns 404 for a letter no title starts with", async () => {
      vi.mocked(Game.find).mockResolvedValue([]);
      vi.mocked(Game.count).mockResolvedValue(0);

      const response = await request(server).get("/letter/q");

      expect(response.status).toBe(404);
    });

    it("should return 404 for multiple characters", async () => {
      const response = await request(server).get("/letter/abc");

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderBy for letter", async () => {
      const response = await request(server).get("/letter/a?orderBy=invalid");

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderDir for letter", async () => {
      const response = await request(server).get("/letter/a?orderDir=INVALID");

      expect(response.status).toBe(404);
    });

    /**
     * The other half of the genre rule above: the pattern admits both cases
     * because the alphabet filter and the heading both work in upper case, so
     * this is where the two spellings collapse into the one address.
     */
    describe("upper case in the path", () => {
      it("301s /letter/A onto /letter/a", async () => {
        const response = await request(server).get("/letter/A");

        expect(response.status).toBe(301);
        expect(response.headers.location).toBe("/letter/a");
      });

      it("keeps the query string exactly as it arrived", async () => {
        const response = await request(server).get("/letter/A?page=2");

        expect(response.status).toBe(301);
        expect(response.headers.location).toBe("/letter/a?page=2");
      });

      it("redirects before deciding whether the letter has any games", async () => {
        // A 301 costs no query. The old behaviour reached Game.find first and
        // would have answered 404 for an upper-case letter with an empty
        // shelf, hiding the real address instead of pointing at it.
        vi.mocked(Game.find).mockResolvedValue([]);
        vi.mocked(Game.count).mockResolvedValue(0);

        const response = await request(server).get("/letter/Q");

        expect(response.status).toBe(301);
        expect(response.headers.location).toBe("/letter/q");
        expect(Game.find).not.toHaveBeenCalled();
      });

      it("still refuses anything that is not a single letter", async () => {
        const response = await request(server).get("/letter/AB");

        expect(response.status).toBe(404);
      });
    });
  });

  describe("GET /developers", () => {
    it("should render developers page", async () => {
      const mockDevelopers = ["Sierra", "LucasArts"];

      vi.mocked(Game.getDevelopers).mockResolvedValue(mockDevelopers);

      const response = await request(server).get("/developers");

      expect(Game.getDevelopers).toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/developers");
      expect(response.body.data.developers).toEqual(mockDevelopers);
    });
  });

  describe("GET /publishers", () => {
    it("should render publishers page", async () => {
      const mockPublishers = ["Sierra", "Electronic Arts"];

      vi.mocked(Game.getPublishers).mockResolvedValue(mockPublishers);

      const response = await request(server).get("/publishers");

      expect(Game.getPublishers).toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/publishers");
      expect(response.body.data.publishers).toEqual(mockPublishers);
    });
  });

  describe("GET /developer/:developer", () => {
    it("should render games for developer", async () => {
      const mockGames = [{ id: 1, title: "Sierra Game", developer: "Sierra" }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.count).mockResolvedValue(1);

      const response = await request(server).get("/developer/Sierra");

      expect(Game.find).toHaveBeenCalledWith({
        developer: "Sierra",
        page: 1,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("index");
      expect(response.body.data.developer).toBe("Sierra");
    });

    it("should handle invalid orderBy for developer", async () => {
      const response = await request(server).get(
        "/developer/Sierra?orderBy=invalid",
      );

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderDir for developer", async () => {
      const response = await request(server).get(
        "/developer/Sierra?orderDir=INVALID",
      );

      expect(response.status).toBe(404);
    });
  });

  describe("GET /publisher/:publisher", () => {
    it("should render games for publisher", async () => {
      const mockGames = [
        { id: 1, title: "EA Game", publisher: "Electronic Arts" },
      ];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.count).mockResolvedValue(1);

      const response = await request(server).get(
        "/publisher/Electronic%20Arts",
      );

      expect(Game.find).toHaveBeenCalledWith({
        publisher: "Electronic Arts",
        page: 1,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("index");
      expect(response.body.data.publisher).toBe("Electronic Arts");
    });

    it("should reject invalid orderBy for publisher", async () => {
      const response = await request(server).get(
        "/publisher/Electronic%20Arts?orderBy=invalid",
      );

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderDir for publisher", async () => {
      const response = await request(server).get(
        "/publisher/Electronic%20Arts?orderDir=INVALID",
      );

      expect(response.status).toBe(404);
    });
  });

  describe("GET /years", () => {
    it("should render years page", async () => {
      const mockYears = [1990, 1991, 1992];

      vi.mocked(Game.getYears).mockResolvedValue(mockYears);

      const response = await request(server).get("/years");

      expect(Game.getYears).toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/years");
      expect(response.body.data.years).toEqual(mockYears);
      expect(response.body.data.title).toContain("Game Years");
    });
  });

  describe("GET /year/:year", () => {
    it("should render games for valid year", async () => {
      const mockGames = [{ id: 1, title: "1990 Game", release: 1990 }];

      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.count).mockResolvedValue(1);

      const response = await request(server).get("/year/1990");

      expect(Game.find).toHaveBeenCalledWith({
        year: 1990,
        page: 1,
        limit: 25,
        orderBy: undefined,
        orderDir: undefined,
      });
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("index");
      expect(response.body.data.year).toBe(1990);
      expect(response.body.data.title).toContain("1990");
    });

    it("should return 404 for invalid year", async () => {
      const response = await request(server).get("/year/invalid");

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderBy for year", async () => {
      const response = await request(server).get("/year/1990?orderBy=invalid");

      expect(response.status).toBe(404);
    });

    it("should reject invalid orderDir for year", async () => {
      const response = await request(server).get("/year/1990?orderDir=INVALID");

      expect(response.status).toBe(404);
    });
  });

  describe("GET /:id", () => {
    // A numeric address is not a second address for the page: every game has
    // had a slug since 0035 made the column NOT NULL, and it is the one the
    // sitemap, the feeds and every link on the site use. Serving "/123" as
    // well left a duplicate of every game in the catalogue.
    it("redirects a numeric ID to the game's slug", async () => {
      const mockGame = {
        id: 123,
        slug: "test-game",
        title: "Test Game",
        genre: "Action",
        images: ["test-image.jpg"],
      };

      vi.mocked(Game.findById).mockResolvedValue(mockGame as any);

      const response = await request(server).get("/123");

      // A number, not the raw "123": the route parses the id through parseId
      // now, so what reaches the model is already known to fit an "integer"
      // column. It used to hand the string straight over, which is how
      // "/9999999999" became a 500 instead of a 404.
      expect(Game.findById).toHaveBeenCalledWith(123);
      expect(response.status).toBe(301);
      expect(response.headers.location).toBe("/test-game");

      // Nothing behind the page is loaded for a redirect.
      expect(Comment.findByGameId).not.toHaveBeenCalled();
      expect(Game.findSimilar).not.toHaveBeenCalled();
    });

    it("should render game detail for slug", async () => {
      const mockGame = {
        id: 123,
        title: "Test Game",
        genre: "Adventure",
        images: ["test-image.jpg"],
      };
      const mockComments: never[] = [];
      const mockSimilarGames: never[] = [];
      const mockAdjacentGames = { prevGame: null, nextGame: null };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);
      vi.mocked(Comment.findByGameId).mockResolvedValue(mockComments as any);
      vi.mocked(Game.findSimilar).mockResolvedValue(mockSimilarGames as any);
      vi.mocked(Game.findAdjacentGames).mockResolvedValue(mockAdjacentGames);

      const response = await request(server).get("/test-game-slug");

      expect(Game.findBySlug).toHaveBeenCalledWith("test-game-slug");
      expect(Comment.findByGameId).toHaveBeenCalledWith(123);
      expect(Game.findSimilar).toHaveBeenCalledWith(123, "Adventure", 6);
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/game-detail");
    });

    it("describes the conversation on the page", async () => {
      const mockGame = {
        id: 123,
        title: "Test Game",
        genre: "Adventure",
        images: ["a.jpg"],
        slug: "test-game",
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);
      vi.mocked(Comment.findByGameId).mockResolvedValue([
        {
          id: 2,
          nick: "player",
          // Stored as sanitized HTML, entity and all.
          content: "<p>Sam &amp; Max were better</p>",
          createdAt: "2024-01-02T03:04:05.000Z",
        },
      ] as any);
      vi.mocked(Comment.countAll).mockResolvedValue(7);
      vi.mocked(Game.findSimilar).mockResolvedValue([] as any);
      vi.mocked(Game.findAdjacentGames).mockResolvedValue({
        prevGame: null,
        nextGame: null,
      });

      const response = await request(server).get("/test-game");

      const { ldJson } = response.body.data;

      expect(ldJson.interactionStatistic).toEqual({
        "@type": "InteractionCounter",
        interactionType: "https://schema.org/CommentAction",
        userInteractionCount: 7,
      });
      expect(ldJson.discussionUrl).toBe(
        "https://oldschoolgames.eu/test-game#comments",
      );
      expect(ldJson.comment).toHaveLength(1);
      // Plain text, with the entity decoded — the same treatment the meta
      // description gets, and for the same reason.
      expect(ldJson.comment[0]).toEqual({
        "@type": "Comment",
        text: "Sam & Max were better",
        dateCreated: "2024-01-02T03:04:05.000Z",
        author: { "@type": "Person", name: "player" },
      });
    });

    /**
     * The VideoGame node's description, which was a bare `slice(0, 500)`.
     *
     * The Comment node a few lines above it in routes/home.ts already cut on
     * a word boundary, so the one game page published both conventions at
     * once — a description ending mid-word beside comments that did not.
     */
    it("cuts an over-long game description on a word boundary", async () => {
      const description = `<p>${"A mighty pirate sails the Caribbean. ".repeat(40)}</p>`;

      vi.mocked(Game.findBySlug).mockResolvedValue({
        id: 123,
        title: "Test Game",
        genre: "Adventure",
        images: ["a.jpg"],
        slug: "test-game",
        description,
      } as any);
      vi.mocked(Comment.findByGameId).mockResolvedValue([] as any);
      vi.mocked(Comment.countAll).mockResolvedValue(0);
      vi.mocked(Game.findSimilar).mockResolvedValue([] as any);
      vi.mocked(Game.findAdjacentGames).mockResolvedValue({
        prevGame: null,
        nextGame: null,
      });

      const { ldJson } = (await request(server).get("/test-game")).body.data;

      // +1 for the ellipsis truncateAtWord appends.
      expect(ldJson.description.length).toBeLessThanOrEqual(LD_TEXT_MAX + 1);
      expect(ldJson.description.endsWith("…")).toBe(true);

      // Cut between words, not through one: what was kept is a prefix of the
      // original, and the character the original carries on with is the space
      // the cut was made at. A `slice` passes the first of these and fails the
      // second, which is the whole difference being asserted here.
      const kept = ldJson.description.slice(0, -1);
      const plain = htmlToPlainText(description);

      expect(kept).not.toMatch(/\s$/);
      expect(plain.startsWith(kept)).toBe(true);
      expect(plain[kept.length]).toBe(" ");
    });

    it("claims no discussion on a game that has none", async () => {
      const mockGame = {
        id: 123,
        title: "Test Game",
        genre: "Adventure",
        images: ["a.jpg"],
        slug: "test-game",
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);
      vi.mocked(Comment.findByGameId).mockResolvedValue([] as any);
      vi.mocked(Comment.countAll).mockResolvedValue(0);
      vi.mocked(Game.findSimilar).mockResolvedValue([] as any);
      vi.mocked(Game.findAdjacentGames).mockResolvedValue({
        prevGame: null,
        nextGame: null,
      });

      const response = await request(server).get("/test-game");

      const { ldJson } = response.body.data;

      // Absent rather than zero or empty: "nobody has commented" is not a
      // fact worth publishing, and `comment: []` asserts emptiness.
      expect(ldJson.interactionStatistic).toBeUndefined();
      expect(ldJson.discussionUrl).toBeUndefined();
      expect(ldJson.comment).toBeUndefined();
    });

    it("decodes the entities a stored description holds", async () => {
      const mockGame = {
        id: 123,
        title: "Sam & Max",
        genre: "Adventure",
        images: ["a.jpg"],
        // What Game.serialize stores for "Sam & Max ride again…":
        // DOMPurify serialises the ampersand as an entity.
        description:
          "<p>Sam &amp; Max ride again in a description long enough to stand on its own.</p>",
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);
      vi.mocked(Comment.findByGameId).mockResolvedValue([] as any);
      vi.mocked(Game.findSimilar).mockResolvedValue([] as any);
      vi.mocked(Game.findAdjacentGames).mockResolvedValue({
        prevGame: null,
        nextGame: null,
      });

      const response = await request(server).get("/sam-max");

      // EJS escapes whatever it is handed, so leaving the entity in place
      // put "&amp;amp;" in the meta tag and search results showed the entity
      // rather than the ampersand.
      expect(response.body.data.description).toBe(
        "Sam & Max ride again in a description long enough to stand on its own.",
      );
      expect(response.body.data.description).not.toContain("&amp;");
    });

    it("cuts a long stored description on a word boundary", async () => {
      const mockGame = {
        id: 123,
        title: "Long Winded",
        genre: "ADVENTURE",
        images: ["a.jpg"],
        description: `<p>${"alpha bravo charlie delta ".repeat(12)}</p>`,
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);
      vi.mocked(Comment.findByGameId).mockResolvedValue([] as any);
      vi.mocked(Game.findSimilar).mockResolvedValue([] as any);
      vi.mocked(Game.findAdjacentGames).mockResolvedValue({
        prevGame: null,
        nextGame: null,
      });

      const response = await request(server).get("/long-winded");
      const { description } = response.body.data;

      expect(description.length).toBeLessThanOrEqual(156);
      expect(description.endsWith("…")).toBe(true);
      // A word boundary, not mid-word: whatever the cut left ends on one of
      // the source's whole words rather than half of one.
      expect(description.replace(/…$/, "")).toMatch(
        /(alpha|bravo|charlie|delta)$/,
      );
    });

    it("keeps the game's own title in the fallback description", async () => {
      const mockGame = {
        id: 123,
        title: "The Secret of Monkey Island",
        slug: "the-secret-of-monkey-island",
        genre: "ADVENTURE",
        release: 1990,
        developer: "Lucasfilm Games",
        images: ["a.jpg"],
        // Nothing stored, so the route composes its own sentence.
        description: null,
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);
      vi.mocked(Comment.findByGameId).mockResolvedValue([] as any);
      vi.mocked(Game.findSimilar).mockResolvedValue([] as any);
      vi.mocked(Game.findAdjacentGames).mockResolvedValue({
        prevGame: null,
        nextGame: null,
      });

      const response = await request(server).get(
        "/the-secret-of-monkey-island",
      );
      const { description } = response.body.data;

      // The title used to be cut to whatever the fixed text left over, which
      // for an ordinary developer name was about sixteen characters: the meta
      // description read "Play The Secret of M… online."
      expect(description).toContain("Play The Secret of Monkey Island online.");
      expect(description).toContain("adventure game from 1990");
      expect(description).toContain("Lucasfilm Games");
      expect(description.length).toBeLessThanOrEqual(156);
    });

    it("keeps the title even when the developer name is long", async () => {
      const mockGame = {
        id: 123,
        title: "Descent to Undermountain",
        slug: "descent-to-undermountain",
        genre: "RPG",
        release: 1997,
        // 29 characters, which used to drive the title's budget negative —
        // substring() returned "" and the description opened "Play … online."
        developer: "Interplay Entertainment Corp.",
        images: ["a.jpg"],
        description: null,
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);
      vi.mocked(Comment.findByGameId).mockResolvedValue([] as any);
      vi.mocked(Game.findSimilar).mockResolvedValue([] as any);
      vi.mocked(Game.findAdjacentGames).mockResolvedValue({
        prevGame: null,
        nextGame: null,
      });

      const response = await request(server).get("/descent-to-undermountain");
      const { description } = response.body.data;

      expect(description).toContain("Play Descent to Undermountain online.");
      expect(description).not.toContain("Play … online.");
      expect(description.length).toBeLessThanOrEqual(156);
    });

    it("leaves room for the sentence when a title is absurdly long", async () => {
      const mockGame = {
        id: 123,
        title: "Word ".repeat(60).trim(),
        slug: "wordy",
        genre: "ACTION",
        release: 1994,
        developer: "Someone",
        images: ["a.jpg"],
        description: null,
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);
      vi.mocked(Comment.findByGameId).mockResolvedValue([] as any);
      vi.mocked(Game.findSimilar).mockResolvedValue([] as any);
      vi.mocked(Game.findAdjacentGames).mockResolvedValue({
        prevGame: null,
        nextGame: null,
      });

      const response = await request(server).get("/wordy");
      const { description } = response.body.data;

      // The title is capped rather than allowed to swallow the whole tag, and
      // what follows it still reads as a sentence.
      expect(description.length).toBeLessThanOrEqual(156);
      expect(description.startsWith("Play Word Word")).toBe(true);
      expect(description).toContain("online. Classic action game");
    });

    it("should return 404 for non-existent game", async () => {
      vi.mocked(Game.findBySlug).mockResolvedValue(null);
      vi.mocked(Game.findById).mockResolvedValue(null);

      const response = await request(server).get("/999");

      expect(response.status).toBe(404);
    });

    it("should return 404 for non-existent slug", async () => {
      vi.mocked(Game.findBySlug).mockResolvedValue(null);

      const response = await request(server).get("/non-existent-slug");

      expect(response.status).toBe(404);
    });

    // All digits, so the old /^\d+$/ test sent it straight to findById as a
    // string. An "integer" column tops out at 2147483647, so Postgres answered
    // "value out of range for type integer" and the visitor got a 500.
    it("should 404 rather than 500 on an id past the integer range", async () => {
      vi.mocked(Game.findBySlug).mockResolvedValue(null);
      vi.mocked(Game.findCurrentSlug).mockResolvedValue(null);

      const response = await request(server).get("/9999999999");

      expect(response.status).toBe(404);
      expect(Game.findById).not.toHaveBeenCalled();
    });

    // "/1.5" reached Postgres as an integer comparison and came back a 500.
    it("should 404 rather than 500 on numeric-looking rubbish", async () => {
      vi.mocked(Game.findBySlug).mockResolvedValue(null);

      for (const path of ["/1.5", "/1e5", "/Infinity", "/0x10"]) {
        const response = await request(server).get(path);

        expect(response.status).toBe(404);
      }

      expect(Game.findById).not.toHaveBeenCalled();
    });

    // A game titled "1942" has the slug "1942", which used to be read as a
    // row id and never found.
    it("should prefer a slug over a row id when both could match", async () => {
      const numericallyTitled = {
        id: 77,
        title: "1942",
        slug: "1942",
        genre: "ACTION",
        images: [],
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(numericallyTitled as any);
      vi.mocked(Comment.findByGameId).mockResolvedValue([] as any);
      vi.mocked(Game.findSimilar).mockResolvedValue([] as any);
      vi.mocked(Game.findAdjacentGames).mockResolvedValue({
        prevGame: null,
        nextGame: null,
      });

      const response = await request(server).get("/1942");

      expect(response.status).toBe(200);
      expect(response.body.data.game.id).toBe(77);
      expect(Game.findById).not.toHaveBeenCalled();
    });

    it("should redirect a renamed game's old address", async () => {
      vi.mocked(Game.findBySlug).mockResolvedValue(null);
      vi.mocked(Game.findCurrentSlug).mockResolvedValue("doom-ii");

      const response = await request(server).get("/doom-2");

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe("/doom-ii");
    });
  });

  describe("GET /profile", () => {
    it("should render profile page", async () => {
      const response = await request(server).get("/profile");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("profile");
    });
  });

  describe("GET /:slug/gallery/:index", () => {
    it("should render game gallery for valid index", async () => {
      const mockGame = {
        id: 1,
        title: "Test Game",
        slug: "test-game",
        description: "A test game description.",
        images: ["image1.jpg", "image2.jpg", "image3.jpg"],
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);

      const response = await request(server).get("/test-game/gallery/1");

      expect(Game.findBySlug).toHaveBeenCalledWith("test-game");
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/game-gallery");
      expect(response.body.data.currentIndex).toBe(1);
    });

    it("builds its snippet from the text, not the stored markup", async () => {
      const mockGame = {
        id: 1,
        title: "Sam & Max",
        slug: "sam-max",
        genre: "ADVENTURE",
        developer: "LucasArts",
        description: "<p>Sam &amp; Max hit the road.</p>",
        images: ["image1.jpg", "image2.jpg"],
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);

      const response = await request(server).get("/sam-max/gallery/1");

      // This used to slice the stored description straight through, so the
      // meta description opened with "<p>Sam &amp;" — and the old cut also
      // dropped the final word even when nothing had been truncated.
      expect(response.body.data.description).toContain(
        "Sam & Max hit the road.",
      );
      expect(response.body.data.description).not.toContain("<p>");
      expect(response.body.data.description).not.toContain("&amp;");
      // The sentence supplies its own full stop after the snippet.
      expect(response.body.data.description).not.toContain("..");
    });

    it("should return 404 for non-existent game in gallery", async () => {
      vi.mocked(Game.findBySlug).mockResolvedValue(null);

      const response = await request(server).get("/non-existent/gallery/0");

      expect(response.status).toBe(404);
    });

    it("should return 404 for invalid index", async () => {
      const mockGame = {
        id: 1,
        title: "Test Game",
        images: ["image1.jpg", "image2.jpg"],
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);

      const response = await request(server).get("/test-game/gallery/invalid");

      expect(response.status).toBe(404);
    });

    it("should return 404 for out of bounds index", async () => {
      const mockGame = {
        id: 1,
        title: "Test Game",
        images: ["image1.jpg", "image2.jpg"],
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);

      const response = await request(server).get("/test-game/gallery/10");

      expect(response.status).toBe(404);
    });

    it("should return 404 for negative index", async () => {
      const mockGame = {
        id: 1,
        title: "Test Game",
        images: ["image1.jpg", "image2.jpg"],
      };

      vi.mocked(Game.findBySlug).mockResolvedValue(mockGame as any);

      const response = await request(server).get("/test-game/gallery/-1");

      expect(response.status).toBe(404);
    });
  });

  describe("GET /random", () => {
    it("redirects to a randomly chosen game", async () => {
      vi.mocked(Game.findRandom).mockResolvedValue({ slug: "doom" } as any);

      const response = await request(server).get("/random");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/doom");
    });

    it("passes a numeric exclusion through to the model", async () => {
      vi.mocked(Game.findRandom).mockResolvedValue({ slug: "quake" } as any);

      await request(server).get("/random?not=42");

      expect(Game.findRandom).toHaveBeenCalledWith(42);
    });

    it("ignores a non-numeric exclusion instead of querying with it", async () => {
      vi.mocked(Game.findRandom).mockResolvedValue({ slug: "quake" } as any);

      await request(server).get("/random?not=drop-table");

      expect(Game.findRandom).toHaveBeenCalledWith(undefined);
    });

    it("falls through instead of redirecting when there is no playable game", async () => {
      vi.mocked(Game.findRandom).mockResolvedValue(null);
      // The request continues down the router, where nothing else matches.
      vi.mocked(Game.getGenres).mockResolvedValue([]);
      vi.mocked(Game.findBySlug).mockResolvedValue(null);

      const response = await request(server).get("/random");

      expect(response.status).toBe(404);
      expect(response.headers.location).toBeUndefined();
    });
  });

  describe("GET / — search", () => {
    it("passes the search term and total to the view", async () => {
      vi.mocked(Game.find).mockResolvedValue([{ id: 1, title: "Doom" }] as any);
      vi.mocked(Game.count).mockResolvedValue(1);

      const response = await request(server).get("/?search=doom");

      expect(response.body.data.search).toBe("doom");
      expect(response.body.data.total).toBe(1);
      expect(response.body.data.title).toContain("doom");
    });

    it("offers close-title suggestions when nothing matched", async () => {
      vi.mocked(Game.find).mockResolvedValue([]);
      vi.mocked(Game.count).mockResolvedValue(0);
      vi.mocked(Game.findTitleSuggestions).mockResolvedValue([
        { title: "Doom", slug: "doom" },
      ] as any);

      const response = await request(server).get("/?search=dooom");

      expect(Game.findTitleSuggestions).toHaveBeenCalledWith("dooom", 5);
      expect(response.body.data.suggestions).toHaveLength(1);
    });

    it("does not look for suggestions when there were results", async () => {
      vi.mocked(Game.find).mockResolvedValue([{ id: 1 }] as any);
      vi.mocked(Game.count).mockResolvedValue(1);

      await request(server).get("/?search=doom");

      expect(Game.findTitleSuggestions).not.toHaveBeenCalled();
    });
  });

  describe("listing totals", () => {
    it("reports the genre total alongside the page of games", async () => {
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
      // A genre holding 137 games has games on its first page. The mock used
      // to report the total against an empty result, which no longer reaches
      // the view: an empty page is a 404 rather than a 200 around nothing.
      vi.mocked(Game.find).mockResolvedValue([{ id: 1 }] as any);
      vi.mocked(Game.count).mockResolvedValue(137);

      const response = await request(server).get("/action");

      expect(Game.count).toHaveBeenCalledWith({ genre: "action" });
      expect(response.body.data.total).toBe(137);
    });

    it("reports the year total", async () => {
      vi.mocked(Game.find).mockResolvedValue([]);
      vi.mocked(Game.count).mockResolvedValue(12);
      vi.mocked(Game.getYears).mockResolvedValue([1993]);

      const response = await request(server).get("/year/1993");

      expect(Game.count).toHaveBeenCalledWith({ year: 1993 });
      expect(response.body.data.total).toBe(12);
    });
  });

  /**
   * What every route in this file puts in the two tags a search result is
   * built from, held to the limits utils/html-text.ts states.
   *
   * These are checked here, on the composed value, rather than only on the
   * literals in tests/content/metadata-limits.test.ts, because most of them do
   * not exist as a literal anywhere: a genre title is built from the genre, a
   * letter description from the games on the page, a game title from the
   * game's own. That composition is exactly where the limits used to be lost —
   * the letter pages reached 213 characters by interpolating four game titles
   * into a sentence that was already close to the limit, and no literal in the
   * codebase was over.
   */
  describe("metadata limits", () => {
    const GAMES = [
      { id: 1, title: "Alone in the Dark", slug: "alone-in-the-dark" },
      { id: 2, title: "Al-Qadim: The Genie's Curse", slug: "al-qadim" },
      { id: 3, title: "Aces of the Deep", slug: "aces-of-the-deep" },
      { id: 4, title: "After Burner II", slug: "after-burner-ii" },
      { id: 5, title: "Abuse", slug: "abuse" },
    ];

    beforeEach(() => {
      vi.mocked(Game.find).mockResolvedValue(GAMES as any);
      vi.mocked(Game.count).mockResolvedValue(200);
      vi.mocked(Game.getYears).mockResolvedValue([1993]);
      vi.mocked(Game.getDevelopers).mockResolvedValue(["id Software"]);
      vi.mocked(Game.getPublishers).mockResolvedValue(["id Software"]);
      // SIMULATION and PLATFORMER are the longest genre names, which is what
      // put the genre titles over the limit — so one of them belongs in here.
      vi.mocked(Game.getGenres).mockResolvedValue(["ACTION", "SIMULATION"]);
    });

    const paths = [
      "/about",
      "/how-to-play",
      "/developers",
      "/publishers",
      "/years",
      "/action",
      "/action?page=2",
      "/simulation",
      "/simulation?page=2",
      "/letter/a",
      "/letter/a?page=2",
      "/year/1993",
      "/year/1993?page=2",
      // Both halves of the developer/publisher pair, with and without a
      // curated STUDIO_DATA entry behind them.
      "/developer/id%20Software",
      "/publisher/id%20Software",
      "/developer/Playmates%20Interactive%20Entertainment",
      "/publisher/Playmates%20Interactive%20Entertainment",
    ];

    it.each(paths)("%s has a title within TITLE_MAX", async (path) => {
      const response = await request(server).get(path);
      const { title } = response.body.data;

      expect(typeof title).toBe("string");
      expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    });

    it.each(paths)(
      "%s has a description within META_DESCRIPTION_MAX",
      async (path) => {
        const response = await request(server).get(path);
        const { description } = response.body.data;

        expect(typeof description).toBe("string");
        expect(description.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
      },
    );

    /**
     * The collision this pair used to have: STUDIO_DATA is keyed by name
     * alone, and both routes read it, so a studio that published its own games
     * — fourteen of them in this catalogue — served two indexable URLs under a
     * byte-identical title and meta description.
     */
    it("gives a studio's developer and publisher pages different metadata", async () => {
      const developer = await request(server).get("/developer/id%20Software");
      const publisher = await request(server).get("/publisher/id%20Software");

      expect(developer.body.data.title).not.toBe(publisher.body.data.title);
      expect(developer.body.data.description).not.toBe(
        publisher.body.data.description,
      );
    });

    // The game detail title gives up " - Play Online" before it gives up any
    // of the game's own name.
    it("keeps a long game title whole by dropping the decoration", async () => {
      vi.mocked(Game.findBySlug).mockResolvedValue({
        id: 1,
        title: "Indiana Jones and the Last Crusade",
        slug: "indiana-jones-and-the-last-crusade",
        images: [],
        description: "",
        genre: "ADVENTURE",
      } as any);
      vi.mocked(Comment.findByGameId).mockResolvedValue([]);
      vi.mocked(Game.findSimilar).mockResolvedValue([]);
      vi.mocked(Game.findAdjacentGames).mockResolvedValue({
        prevGame: null,
        nextGame: null,
      } as any);

      const response = await request(server).get(
        "/indiana-jones-and-the-last-crusade",
      );
      const { title } = response.body.data;

      expect(title).toBe("Indiana Jones and the Last Crusade - OldSchoolGames");
      expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    });
  });
});

/**
 * sidebarData answers a failed genre query with [] rather than undefined, so
 * the "??" the genre route used to fall back with never fell back: every
 * genre page 404ed for as long as the blip lasted. routes/games.ts had
 * already fixed the same expression; this pins the route in home.ts to it.
 */
describe("GET /:genre when the sidebar's genre list is empty", () => {
  const blipApp = express();

  blipApp.use((req, res, next) => {
    res.locals.gameGenres = [];
    res.render = vi.fn((view, data) => {
      res.json({ view, data });
    }) as any;
    next();
  });

  blipApp.use("/", homeRouter);

  const blipServer = blipApp.listen(0);

  afterAll(() => {
    blipServer.close();
  });

  it("asks the model rather than answering 404", async () => {
    vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
    vi.mocked(Game.find).mockResolvedValue([
      { id: 1, title: "Action Game", genre: "ACTION" },
    ] as any);
    vi.mocked(Game.count).mockResolvedValue(1);

    const response = await request(blipServer).get("/action");

    expect(Game.getGenres).toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.body.view).toBe("index");
  });
});
