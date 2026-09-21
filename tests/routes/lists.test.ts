import { beforeEach, describe, expect, it, vi, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import listsRouter, {
  LISTS,
  clearMostPlayedCache,
} from "../../routes/lists.ts";
import Game from "../../models/game.ts";

vi.mock("../../models/game", () => ({
  default: {
    find: vi.fn(),
    count: vi.fn(),
    findMostPlayed: vi.fn(),
  },
}));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.render = vi.fn((view, data) => {
    res.json({ view, data });
  }) as any;
  next();
});

app.use("/", listsRouter);

// Fallthrough 404 for unknown slugs
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

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

describe("Lists Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The page below is cached for five minutes, so it has to start each test
    // cold or the first one answers all of them.
    clearMostPlayedCache();
  });

  describe("GET /most-played", () => {
    const mockGames = [
      { id: 1, title: "Doom", slug: "doom", playCount: 900 },
      { id: 2, title: "Dune II", slug: "dune-ii", playCount: 400 },
    ];

    it("renders the page with the games it asked the model for", async () => {
      vi.mocked(Game.findMostPlayed).mockResolvedValue(mockGames as any);

      const response = await request(server).get("/most-played");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("lists/most-played");
      expect(response.body.data.games).toHaveLength(2);
      expect(Game.findMostPlayed).toHaveBeenCalledWith(100);
      expect(response.body.data.title).toBeDefined();
      expect(response.body.data.description).toBeDefined();
      expect(response.body.data.canonicalUrl).toBeDefined();
    });

    it("serves the second request from the cache", async () => {
      vi.mocked(Game.findMostPlayed).mockResolvedValue(mockGames as any);

      await request(server).get("/most-played");
      await request(server).get("/most-played");

      expect(Game.findMostPlayed).toHaveBeenCalledTimes(1);
    });

    /**
     * The cache had no way in at all before this, so a game deleted from the
     * catalogue stayed on the page for up to five minutes and its link
     * answered a 404. models/game.ts drops it on every write now.
     */
    it("reloads after the cache is cleared", async () => {
      vi.mocked(Game.findMostPlayed).mockResolvedValue(mockGames as any);

      await request(server).get("/most-played");
      clearMostPlayedCache();
      await request(server).get("/most-played");

      expect(Game.findMostPlayed).toHaveBeenCalledTimes(2);
    });

    /**
     * This page was paginated before LIST_SIZE fixed it at a hundred, so
     * every "?page=" is a real address that was linked and crawled — and it
     * went on serving a byte-identical 200 beside the bare one, which is two
     * addresses for one page. The curated lists below have always answered
     * these with a 301; this was the one left serving the duplicate.
     *
     * Any page at all, including "?page=1", for the same reason paginationUrls
     * addresses page 1 as the bare URL.
     */
    it.each(["?page=1", "?page=2", "?page=9999", "?page=nonsense"])(
      "redirects %s onto the page itself",
      async (query) => {
        const response = await request(server).get(`/most-played${query}`);

        expect(response.status).toBe(301);
        expect(response.headers.location).toBe("/most-played");
        // ...and it costs nothing: the list is never loaded to answer one.
        expect(Game.findMostPlayed).not.toHaveBeenCalled();
      },
    );

    it("hands a failed load to the error handler rather than answering", async () => {
      vi.mocked(Game.findMostPlayed).mockRejectedValue(new Error("db down"));

      const response = await request(server).get("/most-played");

      expect(response.status).toBeGreaterThanOrEqual(500);
    });
  });

  describe("GET /game-lists", () => {
    it("should render the lists index page", async () => {
      const response = await request(server).get("/game-lists");
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("lists/lists-index");
    });

    it("should pass all LISTS to the view", async () => {
      const response = await request(server).get("/game-lists");
      expect(response.body.data.lists).toBeDefined();
      expect(response.body.data.lists.length).toBe(LISTS.length);
    });

    it("should include title, description and canonicalUrl in view data", async () => {
      const response = await request(server).get("/game-lists");
      expect(response.body.data.title).toBeDefined();
      expect(response.body.data.description).toBeDefined();
      expect(response.body.data.canonicalUrl).toBeDefined();
    });
  });

  describe("GET /:slug — known list", () => {
    const mockGames = [{ id: 1, title: "Test Game", slug: "test-game" }];

    beforeEach(() => {
      vi.mocked(Game.find).mockResolvedValue(mockGames as any);
      vi.mocked(Game.count).mockResolvedValue(1);
    });

    it("should render list page for a known slug", async () => {
      const response = await request(server).get("/top-dos-games");
      expect(response.status).toBe(200);
      expect(response.body.view).toBe("lists/list");
    });

    it("should pass the games to the view", async () => {
      const response = await request(server).get("/top-dos-games");
      expect(response.body.data.games).toEqual(mockGames);
    });

    /**
     * A curated list is a shortlist, not a second copy of the listing it
     * filters. Unbounded, every one of these paged through exactly what "/"
     * or "/<genre>" already serves, in exactly the same order — Game.find
     * sorts both on the weighted rating by default — so the site ran two sets
     * of addresses over one set of games. See LIST_SIZE in routes/lists.ts.
     */
    it("asks for one capped page rather than paginating", async () => {
      await request(server).get("/top-dos-games");

      expect(vi.mocked(Game.find)).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
      expect(vi.mocked(Game.find).mock.calls[0]![0]).not.toHaveProperty("page");
    });

    it("no longer counts rows it has no pages to divide them into", async () => {
      await request(server).get("/top-dos-games");

      expect(vi.mocked(Game.count)).not.toHaveBeenCalled();
    });

    it("should pass list metadata to the view", async () => {
      const response = await request(server).get("/top-dos-games");
      const { list } = response.body.data;
      expect(list).toBeDefined();
      expect(list.slug).toBe("top-dos-games");
      expect(list.h1).toBeDefined();
      expect(list.title).toBeDefined();
    });

    it("should pass relatedLists array to the view", async () => {
      const response = await request(server).get("/top-dos-games");
      expect(Array.isArray(response.body.data.relatedLists)).toBe(true);
      expect(response.body.data.relatedLists.length).toBeGreaterThan(0);
    });

    it("should return the canonical URL of the list itself", async () => {
      const response = await request(server).get("/top-dos-games");
      expect(response.body.data.canonicalUrl).toBe(
        "https://oldschoolgames.eu/top-dos-games",
      );
    });

    it("advertises no prev or next page", async () => {
      const response = await request(server).get("/top-dos-games");
      expect(response.body.data.prevPageUrl).toBeUndefined();
      expect(response.body.data.nextPageUrl).toBeUndefined();
    });

    /**
     * Every page of every list was a real address that answered 200 while
     * these were paginated — linked from the pagination control and crawled.
     * They mean "this list" now, and say so with a 301 rather than quietly
     * serving the same page under a query string.
     */
    it("redirects a ?page= address onto the list", async () => {
      const response = await request(server).get("/top-dos-games?page=2");

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe("/top-dos-games");
    });

    it("redirects ?page=1 too, rather than serving a second copy", async () => {
      const response = await request(server).get("/top-dos-games?page=1");

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe("/top-dos-games");
    });

    it("redirects without touching the database", async () => {
      await request(server).get("/top-dos-games?page=7");

      expect(vi.mocked(Game.find)).not.toHaveBeenCalled();
    });

    it("should pass RPG genre filter for best-rpg-games list", async () => {
      const response = await request(server).get("/best-rpg-games");
      expect(response.status).toBe(200);
      expect(vi.mocked(Game.find)).toHaveBeenCalledWith(
        expect.objectContaining({ genre: "RPG" }),
      );
    });

    it("should pass PUZZLE genre filter for best-puzzle-games list", async () => {
      await request(server).get("/best-puzzle-games");
      expect(vi.mocked(Game.find)).toHaveBeenCalledWith(
        expect.objectContaining({ genre: "PUZZLE" }),
      );
    });

    it("should render all known list slugs", async () => {
      for (const list of LISTS) {
        vi.mocked(Game.find).mockResolvedValue(mockGames as any);
        vi.mocked(Game.count).mockResolvedValue(1);

        const response = await request(server).get(`/${list.slug}`);
        expect(response.status).toBe(200);
        expect(response.body.view).toBe("lists/list");
      }
    });
  });

  describe("GET /:slug — unknown slug", () => {
    it("returns 404 for an unknown slug", async () => {
      const response = await request(server).get("/nonexistent-list-slug");
      expect(response.status).toBe(404);
    });
  });

  /**
   * Every "best-<genre>-games" list is one genre, and a genre the catalogue
   * holds nothing for answers 404 at "/<genre>" — so the list saying 200 was
   * the site disagreeing with itself about whether a page exists, and
   * routes/sitemap.ts advertised the 200 to crawlers.
   */
  describe("GET /:slug — a list with nothing in it", () => {
    beforeEach(() => {
      vi.mocked(Game.find).mockResolvedValue([]);
      vi.mocked(Game.count).mockResolvedValue(0);
    });

    it("returns 404 rather than a page around an empty list", async () => {
      const response = await request(server).get("/best-horror-games");
      expect(response.status).toBe(404);
    });

    it("returns 404 for every list, not only the genre ones", async () => {
      for (const list of LISTS) {
        const response = await request(server).get(`/${list.slug}`);
        expect(response.status, `/${list.slug} should be 404`).toBe(404);
      }
    });

    // A page past the end of a list used to be a 404 of its own. There are no
    // pages to be past the end of now, so the address redirects with every
    // other ?page= — and the emptiness it was guarding is still caught, by
    // the case above this one.
    it("redirects a page past the end rather than 404ing", async () => {
      const response = await request(server).get("/top-dos-games?page=99");

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe("/top-dos-games");
    });
  });
});
