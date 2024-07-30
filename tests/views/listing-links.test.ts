import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import { genreInSentence, genreLabel } from "../../utils/genre-label.ts";
import {
  breadcrumbLdJson,
  buildBreadcrumbs,
} from "../../utils/breadcrumbs.ts";
import { isNoindex } from "../../utils/indexability.ts";
import {
  SITE_DESCRIPTION,
  SITE_IMAGE,
  SITE_IMAGE_HEIGHT,
  SITE_IMAGE_WIDTH,
  SITE_NAME,
  SITE_TITLE,
  SITE_URL,
  absoluteUrl,
} from "../../utils/site.ts";

/**
 * The chrome's links to listing pages, rendered for real.
 *
 * Every page of the site carries a sidebar of genres, a footer of genres and
 * years, and every listing an A–Z filter — and each of them linked every value
 * it knew: all thirteen GAME_GENRE values, all twenty-six letters, five genres
 * and six years written into the footer by hand. Every one of those pages
 * answers 404 when the catalogue holds nothing for it, so on a catalogue with
 * a gap the site's own navigation handed every visitor and every crawl a
 * supply of dead ends — "/horror", "/other", "/letter/z" — while
 * routes/sitemap.ts had stopped listing the very same pages long ago.
 *
 * The locals are what middlewares/sidebar-data.ts puts on every page (see
 * NonEmptyListings there). Each is also rendered without them, because a page
 * rendered without the middleware — or after its query failed — has to link
 * everything rather than nothing.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

/** The whole enum, as Game.getGenres() reads it. */
const ENUM = [
  "ACTION",
  "ADVENTURE",
  "RPG",
  "STRATEGY",
  "SIMULATION",
  "SPORTS",
  "PUZZLE",
  "HORROR",
  "PLATFORMER",
  "RACING",
  "FIGHTING",
  "SHOOTER",
  "OTHER",
];

/** A catalogue with gaps: two of the thirteen genres, one year of six. */
const GAPS = {
  gameGenres: ENUM,
  nonEmptyGenres: new Set(["ACTION", "RPG"]),
  nonEmptyYears: new Set([1993]),
  nonEmptyListSlugs: new Set(["best-action-games"]),
};

function render(
  file: string,
  locals: Record<string, unknown> = {},
): Promise<string> {
  return ejs.renderFile(
    path.join(VIEWS, file),
    {
      genreLabel,
      csrfToken: "t",
      req: {
        path: "/somewhere",
        originalUrl: "/somewhere",
        query: {},
        params: {},
        session: {},
      },
      ...locals,
    },
    { root: VIEWS, views: [VIEWS] },
  );
}

function hrefs(html: string, selector = "a"): string[] {
  const { document } = new JSDOM(html).window;

  return [...document.querySelectorAll(selector)]
    .map((a) => a.getAttribute("href"))
    .filter((href): href is string => href !== null);
}

/** Every link that names a genre's listing page: "/action", "/rpg". */
const genreHrefs = (html: string) =>
  hrefs(html).filter((href) =>
    ENUM.some((genre) => href === `/${genre.toLowerCase()}`),
  );

describe("the left sidebar's genres", () => {
  it("links only the genres a game is filed under", async () => {
    expect(genreHrefs(await render("left-sidebar.ejs", GAPS))).toEqual([
      "/action",
      "/rpg",
    ]);
  });

  it("links every genre when the counts are not known", async () => {
    expect(
      genreHrefs(await render("left-sidebar.ejs", { gameGenres: ENUM })),
    ).toHaveLength(ENUM.length);
  });
});

describe("the error pages' genre row", () => {
  it("offers only genres with games, still at most eight", async () => {
    expect(genreHrefs(await render("error-nav.ejs", GAPS))).toEqual([
      "/action",
      "/rpg",
    ]);

    // A catalogue with every genre filled still gets the first eight.
    expect(
      genreHrefs(
        await render("error-nav.ejs", {
          gameGenres: ENUM,
          nonEmptyGenres: new Set(ENUM),
        }),
      ),
    ).toHaveLength(8);
  });

  it("offers the first eight when the counts are not known", async () => {
    expect(
      genreHrefs(await render("error-nav.ejs", { gameGenres: ENUM })),
    ).toEqual(ENUM.slice(0, 8).map((genre) => `/${genre.toLowerCase()}`));
  });
});

/**
 * The footer is on every page and its links are written into it by hand, so
 * its genres and years are checked against the same counts rather than
 * trusted to exist.
 */
describe("the footer", () => {
  it("links only the genres and years that have games", async () => {
    const html = await render("footer.ejs", GAPS);

    // The row's Action and RPG, then the function-key bar's Action; the
    // three genres of the five with nothing in them, and the bar's
    // Adventure, are gone.
    expect(genreHrefs(html)).toEqual(["/action", "/rpg", "/action"]);
    expect(hrefs(html).filter((href) => href.startsWith("/year/"))).toEqual([
      "/year/1993",
    ]);
  });

  it("links all of them when the counts are not known", async () => {
    const html = await render("footer.ejs");

    // Five genres in the row and two on the function-key bar.
    expect(genreHrefs(html)).toHaveLength(7);
    expect(
      hrefs(html).filter((href) => href.startsWith("/year/")),
    ).toHaveLength(6);
  });

  it("leaves no separator dangling when a link is left out", async () => {
    const { document } = new JSDOM(await render("footer.ejs", GAPS)).window;
    const rows = [...document.querySelectorAll(".footer-content > div")].map(
      (row) => row.textContent!.replace(/\s+/g, " ").trim(),
    );

    expect(rows).toContain("Genres: Action | RPG");
    expect(rows).toContain("Years: 1993");

    for (const row of rows) {
      expect(row).not.toMatch(/\|\s*$/);
      expect(row).not.toMatch(/:\s*\|/);
    }
  });
});

/**
 * The A–Z filter keeps all twenty-seven of its buttons, so the row does not
 * change shape with the catalogue — only the ones with a page behind them are
 * links. The rest are placeholders: an <a> without an href, which HTML defines
 * as exactly that and which neither a crawler nor the keyboard treats as a
 * link, while the .alphabet-links a rules still give it the same box.
 */
describe("the alphabet filter", () => {
  const BUCKETS = [
    { bucket: "0-9", label: "0–9", linked: true },
    { bucket: "a", label: "A", linked: false },
    { bucket: "d", label: "D", linked: true },
    { bucket: "z", label: "Z", linked: false },
  ];

  it("links only the pages that have games", async () => {
    const html = await render("games/alphabet-filter.ejs", {
      letterBuckets: BUCKETS,
    });

    expect(hrefs(html, ".alphabet-links a")).toEqual([
      "/letter/0-9",
      "/letter/d",
      "/",
    ]);
  });

  it("keeps the empty ones in the row, as text", async () => {
    const { document } = new JSDOM(
      await render("games/alphabet-filter.ejs", { letterBuckets: BUCKETS }),
    ).window;
    const buttons = [...document.querySelectorAll(".alphabet-links a")];

    expect(buttons.map((button) => button.textContent!.trim())).toEqual([
      "0–9",
      "A",
      "D",
      "Z",
      "All",
    ]);

    const empty = buttons.filter((button) => !button.hasAttribute("href"));

    expect(empty.map((button) => button.textContent!.trim())).toEqual([
      "A",
      "Z",
    ]);
  });

  it("marks the page the reader is on", async () => {
    const { document } = new JSDOM(
      await render("games/alphabet-filter.ejs", {
        letterBuckets: BUCKETS,
        req: { params: { letter: "0-9" }, query: {}, session: {} },
      }),
    ).window;

    expect(
      [...document.querySelectorAll(".alphabet-links a.active")].map((a) =>
        a.getAttribute("href"),
      ),
    ).toEqual(["/letter/0-9"]);
  });
});

/**
 * The panel a search that found nothing offers, whose "Top DOS games" button
 * is a curated list like any other — and answers 404 on a catalogue with
 * nothing in it at all.
 */
describe("the no-results panel", () => {
  const renderPanel = (locals: Record<string, unknown>) =>
    render("games/game-list.ejs", {
      games: [],
      search: "zzz",
      suggestions: [],
      page: 1,
      limit: 25,
      total: 0,
      ...locals,
    });

  it("offers the top list only when it holds something", async () => {
    expect(
      hrefs(await renderPanel({ nonEmptyListSlugs: new Set() })),
    ).not.toContain("/top-dos-games");
    expect(
      hrefs(
        await renderPanel({ nonEmptyListSlugs: new Set(["top-dos-games"]) }),
      ),
    ).toContain("/top-dos-games");
  });

  it("offers it when the counts are not known", async () => {
    expect(hrefs(await renderPanel({}))).toContain("/top-dos-games");
  });
});

/**
 * The "Popular" block on /developers and /publishers.
 *
 * It was `developers.slice(0, 8)` — the first eight names of a list sorted by
 * name — so "Popular Developers" was the start of the alphabet. The route
 * ranks the studios by how many games each has now (see mostGames in
 * routes/home.ts) and the page draws what it was handed.
 */
describe("the Popular block on the studio pages", () => {
  const ALPHABETICAL = [
    "Accolade",
    "Apogee",
    "Bullfrog",
    "id Software",
    "Sierra",
    "Westwood",
  ];

  const renderStudios = (
    file: string,
    locals: Record<string, unknown>,
  ): Promise<string> =>
    render(file, {
      asset: (urlPath: string) => urlPath,
      siteUrl: SITE_URL,
      siteTitle: SITE_TITLE,
      siteDescription: SITE_DESCRIPTION,
      siteName: SITE_NAME,
      siteImage: SITE_IMAGE,
      siteImageWidth: SITE_IMAGE_WIDTH,
      siteImageHeight: SITE_IMAGE_HEIGHT,
      buildBreadcrumbs,
      breadcrumbLdJson,
      isNoindex,
      genreInSentence,
      absoluteUrl,
      cspNonce: "n",
      searchQuery: "",
      title: "Studios",
      description: "Studios.",
      ...locals,
    });

  /**
   * The names in the ranked block, in the order the page shows them. Found by
   * what its heading says the ranking is — "…with the Most Games" — since
   * the heading stopped calling it "Popular", which nothing here measures.
   */
  function popular(html: string): string[] {
    const { document } = new JSDOM(html).window;
    const heading = [...document.querySelectorAll("main h2, main h3")].find(
      (element) => /with the Most Games/.test(element.textContent!),
    );

    if (!heading) return [];

    return [...heading.parentElement!.querySelectorAll("a")].map((a) =>
      a.textContent!.trim(),
    );
  }

  it.each([
    ["games/developers.ejs", "developers", "popularDevelopers"],
    ["games/publishers.ejs", "publishers", "popularPublishers"],
  ])("%s shows the ranking it is handed", async (file, list, ranked) => {
    const html = await renderStudios(file, {
      [list]: ALPHABETICAL,
      [ranked]: ["Sierra", "Apogee", "id Software"],
    });

    expect(popular(html)).toEqual(["Sierra", "Apogee", "id Software"]);
  });

  it.each([
    ["games/developers.ejs", "developers", "popularDevelopers"],
    ["games/publishers.ejs", "publishers", "popularPublishers"],
  ])(
    "%s leaves the block out rather than fill it from the alphabet",
    async (file, list, ranked) => {
      const html = await renderStudios(file, {
        [list]: ALPHABETICAL,
        [ranked]: [],
      });

      expect(popular(html)).toEqual([]);
      // And the full list is still all there.
      expect(hrefs(html, ".company-list a")).toHaveLength(ALPHABETICAL.length);
    },
  );
});
