import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import {
  breadcrumbLdJson,
  buildBreadcrumbs,
} from "../../utils/breadcrumbs.ts";
import { isNoindex } from "../../utils/indexability.ts";
import { genreInSentence, genreLabel } from "../../utils/genre-label.ts";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

const read = (file: string) => readFileSync(file, "utf-8");

/**
 * The heading levels inside <main>, in document order.
 *
 * Inside <main> because the left sidebar comes first in the markup and opens
 * with an <h2> of its own ("Genres"), which is a landmark's heading and not
 * part of the page's outline.
 */
function outline(html: string): number[] {
  const { document } = new JSDOM(html).window;

  return [...document.querySelectorAll("main h1, main h2, main h3, main h4")].map(
    (heading) => Number(heading.tagName.slice(1)),
  );
}

/** Every level at most one below the deepest one reached before it. */
function expectNoSkippedLevel(levels: number[]): void {
  expect(levels[0]).toBe(1);

  levels.slice(1).forEach((level, index) => {
    expect(level).toBeLessThanOrEqual(
      Math.max(...levels.slice(0, index + 1)) + 1,
    );
  });
}

/** Every template that opens a <body> — i.e. every whole page. */
const pages = globSync("views/**/*.ejs").filter((file) =>
  /<body[\s>]/.test(read(file)),
);

/**
 * "Skip to content", and the landing it needs to be worth having.
 *
 * WCAG 2.4.1 asks for a way past the blocks of navigation that repeat on
 * every page, and this site repeats two of them — the navbar's three rows
 * and a sidebar of thirty-odd links — before a single word of content. There
 * was no such link anywhere, so reaching the first paragraph of a game page
 * from the keyboard meant tabbing through all of it, on every page, every
 * time.
 *
 * The link lives at the top of views/navbar.ejs because that partial is the
 * first child of <body> in every layout that has chrome; the gallery
 * overlay, which has no navbar, carries its own. What matters is that the
 * pair is complete — a link with no target scrolls nowhere, and a <main>
 * with no link is unreachable — so both halves are checked for every page.
 */
describe("skip link", () => {
  it("has pages to check", () => {
    expect(pages.length).toBeGreaterThan(20);
  });

  it("is the first thing in views/navbar.ejs", () => {
    const navbar = read(path.join(VIEWS, "navbar.ejs"));

    // Ahead of <header class="navbar">, and so ahead of every focusable
    // thing on the page. A skip link that is not first is skipped past.
    expect(navbar.indexOf('class="skip-link"')).toBeGreaterThanOrEqual(0);
    expect(navbar.indexOf('class="skip-link"')).toBeLessThan(
      navbar.indexOf('<header class="navbar">'),
    );
  });

  it.each(pages)("%s offers the link", (file) => {
    const source = read(file);
    const hasNavbar = /include\((['"])\.{0,2}\/?navbar\1\)/.test(source);

    expect(hasNavbar || source.includes('class="skip-link"')).toBe(true);
  });

  it.each(pages)(
    "%s has a <main> for it to land on",
    (file) => {
      expect(read(file)).toMatch(/<main id="main" tabindex="-1">/);
    },
  );

  // tabindex="-1" is what lets the browser move focus there. Without it the
  // page scrolls and focus stays on the link, so the next Tab goes straight
  // back into the navbar the visitor just asked to skip.
  it("leaves no <main> without the two attributes", () => {
    // Anchored to the start of a line so the tag quoted inside a template
    // comment — views/error-nav.ejs explains the empty <main> these pages
    // used to be — is not read as markup.
    const offenders = globSync("views/**/*.ejs").filter(
      (file) =>
        /^\s*<main(?![^>]*id="main")/m.test(read(file)),
    );

    expect(offenders).toEqual([]);
  });

  it("points every link at that id", () => {
    const hrefs = globSync("views/**/*.ejs")
      .flatMap((file) => [...read(file).matchAll(/class="skip-link" href="([^"]*)"/g)])
      .map((match) => match[1]);

    expect(hrefs.length).toBeGreaterThan(0);
    expect(new Set(hrefs)).toEqual(new Set(["#main"]));
  });
});

/**
 * Two <aside> elements with no accessible name are two "complementary"
 * landmarks a screen reader can only tell apart by counting, and the section
 * titles inside them were <header> elements — a landmark of their own, with
 * no level, invisible to the heading list a reader navigates a page by.
 */
describe("sidebar landmarks", () => {
  const sidebars = ["left-sidebar.ejs", "right-sidebar.ejs"];

  it.each(sidebars)("%s names itself", (file) => {
    const source = read(path.join(VIEWS, file));
    const label = /<aside[^>]*aria-label="([^"]+)"/.exec(source)?.[1];

    expect(label).toBeTruthy();
  });

  it("gives the two of them different names", () => {
    const labels = sidebars.map(
      (file) =>
        /<aside[^>]*aria-label="([^"]+)"/.exec(
          read(path.join(VIEWS, file)),
        )?.[1],
    );

    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each(sidebars)("%s titles its sections with headings", (file) => {
    const source = read(path.join(VIEWS, file));

    expect(source).not.toMatch(/<header>/);
    expect([...source.matchAll(/<h2>/g)].length).toBeGreaterThan(3);
  });
});

/**
 * A heading level is a document outline, not a font size. developers.ejs,
 * publishers.ejs and years.ejs each went from the page <h1> straight to an
 * <h3>, which leaves a reader jumping a level for no reason.
 */
describe("heading levels", () => {
  it.each(["games/developers.ejs", "games/publishers.ejs", "games/years.ejs"])(
    "%s does not skip from h1 to h3",
    (file) => {
      const levels = [
        ...read(path.join(VIEWS, file)).matchAll(/<h([1-6])[\s>]/g),
      ].map((match) => Number(match[1]));

      expect(levels[0]).toBe(1);

      levels.slice(1).forEach((level, index) => {
        expect(level).toBeLessThanOrEqual(Math.max(...levels.slice(0, index + 1)) + 1);
      });
    },
  );
});

/**
 * The same rule, on pages whose outline depends on what they render — which
 * the source-order check above cannot see.
 *
 * A game page's source reads h1, h2, h3 top to bottom, but the h2 ("Just play
 * it!") is only drawn for a game with a stream. Without one the first heading
 * after the title was "Explore More", an <h3> — a level skipped on every
 * unplayable game in the catalogue.
 */
describe("heading levels, rendered", () => {
  function renderGamePage(stream: string): Promise<string> {
    const game = {
      id: 1,
      title: "Doom",
      slug: "doom",
      genre: "ACTION",
      release: 1993,
      developer: "id Software",
      publisher: "GT Interactive",
      description: "<p>Classic FPS.</p>",
      cover: "",
      images: [],
      stream,
      manual: "",
      averageRating: 0,
      ratingCount: 0,
    };

    return ejs.renderFile(
      path.join(VIEWS, "games/game-detail.ejs"),
      {
        game,
        comments: [],
        commentCount: 0,
        remainingComments: 0,
        similarGames: [],
        prevGame: null,
        nextGame: null,
        userRating: null,
        title: "Doom - Play Online - OldSchoolGames",
        description: "Classic FPS.",
        canonicalUrl: `${SITE_URL}/doom`,
        ldJson: { "@type": "VideoGame", name: "Doom" },
        asset: (file: string) => file,
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
        genreLabel,
        genreInSentence,
        absoluteUrl,
        csrfToken: "t",
        cspNonce: "n",
        searchQuery: "",
        req: {
          path: "/doom",
          originalUrl: "/doom",
          query: {},
          params: {},
          session: {},
        },
      },
      { root: VIEWS, views: [VIEWS] },
    );
  }

  it("skips no level on a game page with nothing to play", async () => {
    expectNoSkippedLevel(outline(await renderGamePage("")));
  });

  it("skips no level on a game page with a player either", async () => {
    expectNoSkippedLevel(outline(await renderGamePage("doom.jsdos")));
  });

  /**
   * The card's own title. Every listing grid renders it under an <h2> of its
   * own (views/games/game-filters.ejs), which is what the default is for; a
   * caller with nothing between its <h1> and the cards says so.
   */
  describe("the game card's title", () => {
    const card = (locals: Record<string, unknown> = {}) =>
      ejs.renderFile(
        path.join(VIEWS, "games/game-item.ejs"),
        {
          game: {
            id: 1,
            title: "Doom",
            slug: "doom",
            genre: "ACTION",
            cover: "",
            summary: "",
          },
          csrfToken: "t",
          req: {},
          ...locals,
        },
        { root: VIEWS, views: [VIEWS] },
      );

    const titleTag = async (locals?: Record<string, unknown>) =>
      new JSDOM(await card(locals)).window.document
        .querySelector("article a")
        ?.firstElementChild?.tagName.toLowerCase();

    it("is an <h3> by default, under the grid's own heading", async () => {
      expect(await titleTag()).toBe("h3");
    });

    it("is the level its caller asks for", async () => {
      expect(await titleTag({ headingLevel: 2 })).toBe("h2");
    });

    it("refuses a level that is not a heading", async () => {
      expect(await titleTag({ headingLevel: 9 })).toBe("h3");
      expect(await titleTag({ headingLevel: "2><script" })).toBe("h3");
    });
  });
});

/**
 * The comment form without JavaScript.
 *
 * It had no action and no method, so a browser submitting it on its own
 * re-requested the page it was on as a GET and dropped the comment. The
 * attributes cost the fetch path nothing — comments.js calls preventDefault
 * before the browser reads them — and routes/comments.ts answers a
 * form-encoded post with a redirect instead of a fragment.
 */
describe("comment form works without a script", () => {
  const source = read(path.join(VIEWS, "comments/comment-form.ejs"));

  it("posts somewhere", () => {
    expect(source).toMatch(/action="\/comments"/);
    expect(source).toMatch(/method="POST"/i);
  });

  it("carries the CSRF token as a field, not only as a header", () => {
    expect(source).toMatch(/name="_csrf"/);
  });
});

/**
 * Re-sorting a listing threw away the rest of the address: the four sort
 * links wrote a bare "?orderBy=…", so sorting a set of search results
 * replaced them with the whole unfiltered catalogue.
 */
/**
 * The listing's own <h2>, on a letter page. It used to upper-case the route
 * parameter itself, so the digits' page read "Games starting with '0-9'" —
 * a range of characters — while its <h1> already said "a Number".
 */
describe("game-filters heading on a letter page", () => {
  const heading = async (locals: Record<string, unknown>) => {
    const html = await ejs.renderFile(
      path.join(VIEWS, "games/game-filters.ejs"),
      { req: { query: {} }, ...locals },
      { root: VIEWS, views: [VIEWS] },
    );

    return new JSDOM(html).window.document
      .querySelector("h2")
      ?.textContent?.replace(/\s+/g, " ")
      .trim();
  };

  it("names the digits' bucket the way the route does", async () => {
    const text = await heading({ letter: "0-9", letterInSentence: "a number" });

    expect(text).toBe("Games starting with a number");
    expect(text).not.toContain("0-9");
  });

  it("still quotes a letter", async () => {
    expect(await heading({ letter: "a", letterInSentence: "'A'" })).toBe(
      "Games starting with 'A'",
    );
  });

  it("falls back to the parameter when a caller passes no name", async () => {
    expect(await heading({ letter: "q" })).toBe("Games starting with 'Q'");
  });
});

describe("game-filters sort links", () => {
  async function hrefs(
    query: Record<string, string | string[]>,
    selector = ".sorting-options a:not(.hover-scale)",
  ) {
    const html = await ejs.renderFile(
      path.join(VIEWS, "games/game-filters.ejs"),
      { req: { query }, search: query.search },
      { root: VIEWS, views: [VIEWS] },
    );

    const { document } = new JSDOM(html).window;

    return Array.from(
      document.querySelectorAll<HTMLAnchorElement>(selector),
    ).map((a) => a.getAttribute("href")!);
  }

  // The four named sorts only; the two ▲/▼ arrows have a describe of their
  // own below, because they were built a different way and had bugs of their
  // own.
  const render = (query: Record<string, string>) => hrefs(query);

  it("keeps the search the visitor typed", async () => {
    const hrefs = await render({ search: "doom" });

    hrefs.forEach((href) => expect(href).toContain("search=doom"));
  });

  it("drops the page, which the new order invalidates", async () => {
    const hrefs = await render({ search: "doom", page: "7" });

    hrefs.forEach((href) => expect(href).not.toContain("page="));
  });

  it("still sets the sort it is there to set", async () => {
    const links = await render({ search: "doom" });

    expect(links[0]).toContain("orderBy=title");
    expect(links[0]).toContain("orderDir=ASC");
  });

  /**
   * The two ▲/▼ arrows, which used to build their own href by spreading
   * req.query into URLSearchParams inline. That had three faults the four
   * sorts above did not: a repeated key came out comma-joined, an undefined
   * value came out as the string "undefined", and `page` was carried over —
   * so page 7 of an ascending listing linked to page 7 of the descending one,
   * a different set of games under the same number.
   */
  describe("the direction arrows", () => {
    const arrows = (query: Record<string, string | string[]>) =>
      hrefs(query, ".sorting-options a.hover-scale");

    it("sets the direction and keeps the field", async () => {
      const [asc, desc] = await arrows({ orderBy: "title", search: "doom" });

      expect(asc).toContain("orderDir=ASC");
      expect(desc).toContain("orderDir=DESC");

      for (const href of [asc, desc]) {
        expect(href).toContain("orderBy=title");
        expect(href).toContain("search=doom");
        // Once, not twice: the incoming orderDir is replaced, not appended to.
        expect(href!.match(/orderDir=/g)).toHaveLength(1);
      }
    });

    it("drops the page, which the new direction invalidates", async () => {
      const links = await arrows({ orderBy: "title", page: "7" });

      links.forEach((href) => expect(href).not.toContain("page="));
    });

    /**
     * A repeated key is an array in req.query, and the object form of
     * URLSearchParams stringifies an array by joining it with commas — which
     * is the same bug views/pagination.ejs was fixed for.
     */
    it("keeps a repeated parameter repeated", async () => {
      const [asc] = await arrows({ genre: ["rpg", "action"] });

      expect(asc).toContain("genre=rpg");
      expect(asc).toContain("genre=action");
      expect(asc).not.toContain("rpg%2Caction");
      expect(asc).not.toContain("rpg,action");
    });

    it("writes no orderBy when the request carried none", async () => {
      const [asc] = await arrows({});

      expect(asc).toBe("?orderDir=ASC");
    });

    // A search with no field is ranked by relevance, which has no direction:
    // the arrows produced the same list in the same order while marking
    // themselves active.
    it("are not offered on a search ranked by relevance", async () => {
      expect(await arrows({ search: "doom" })).toEqual([]);
    });

    it("come back once the search is sorted by a field", async () => {
      expect(await arrows({ search: "doom", orderBy: "title" })).toHaveLength(2);
    });
  });
});

/**
 * The gallery's Next arrow.
 *
 * Its path data had lost three minus signs somewhere — "c-12.5 12.5 32.8
 * 12.5 45.3 0s12.5-32.8 0-45.3" where Previous has "c-12.5 12.5-32.8
 * 12.5-45.3 0s-12.5-32.8 0-45.3" mirrored — so the curve folded back on
 * itself and the chevron rendered as a blot. The two arrows are the same
 * glyph pointing opposite ways, which is what makes this checkable: the
 * four copies on the page are two distinct paths, not three or four.
 */
describe("gallery arrows", () => {
  const source = read(path.join(VIEWS, "games/game-gallery.ejs"));
  const paths = [...source.matchAll(/<path d="([^"]+)"/g)].map(
    (match) => match[1],
  );

  it("draws four of them", () => {
    expect(paths).toHaveLength(4);
  });

  it("uses exactly two distinct shapes", () => {
    expect(new Set(paths).size).toBe(2);
  });

  it("gives the enabled and disabled Next the same shape", () => {
    // Previous, Previous (disabled), Next, Next (disabled) in source order.
    expect(paths[0]).toBe(paths[1]);
    expect(paths[2]).toBe(paths[3]);
  });

  /**
   * A modified arrow or Escape belongs to the browser. Alt+Left and Cmd+Left
   * are Back, Ctrl+Left jumps a word — and this page's document-level handler
   * answered all of them by navigating to the next screenshot instead, so the
   * visitor ended up somewhere they had asked to leave.
   */
  it("leaves a modified key to the browser", () => {
    expect(source).toMatch(
      /if \(event\.ctrlKey \|\| event\.altKey \|\| event\.metaKey\) return;/,
    );
  });

  /**
   * The picture is a screenshot of whatever mode the game ran in, which is
   * not always 320x200 — box art is portrait and later titles ran at 320x240
   * or 640x480. An intrinsic size stated wrongly reserves a box of the wrong
   * shape; the stylesheet gives the wrapper a floor instead.
   */
  it("does not state an intrinsic size it cannot know", () => {
    // Matched by line rather than by "<img …>": the attributes hold EJS tags,
    // and a "%>" inside one ends any [^>]* the pattern tries to span.
    const img = source
      .split("\n")
      .find((line) => line.includes('class="gallery-image"'));

    expect(img).toBeTruthy();
    expect(img).not.toMatch(/\bwidth=/);
    expect(img).not.toMatch(/\bheight=/);
  });

  // The overlay has to be reachable on a screen too short for it — the body
  // lock made the part that did not fit unreachable rather than merely
  // cramped.
  it("does not lock the page against scrolling", () => {
    expect(source).not.toMatch(/<body[^>]*overflow:\s*hidden/);
  });
});

/**
 * Every template parses.
 *
 * Nothing checked this, and it is cheaper to check than to find: an EJS
 * comment is scanned for its closing delimiter like any other tag, so
 * writing "<%= %>" inside one to explain what the template does ends the
 * comment early and leaves the compiler looking for a close tag that is no
 * longer there. The template then throws at render time — a 500 on whichever
 * page includes it — and the route tests, which mock res.render and assert
 * on locals, never run the file at all.
 */
describe("templates", () => {
  it.each(globSync("views/**/*.ejs"))("%s compiles", (file) => {
    expect(() =>
      ejs.compile(read(file), { filename: file }),
    ).not.toThrow();
  });
});
