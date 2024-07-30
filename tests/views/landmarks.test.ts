import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

const read = (file: string) => readFileSync(file, "utf-8");

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
describe("game-filters sort links", () => {
  async function render(query: Record<string, string>) {
    const html = await ejs.renderFile(
      path.join(VIEWS, "games/game-filters.ejs"),
      { req: { query }, search: query.search },
      { root: VIEWS, views: [VIEWS] },
    );

    const { document } = new JSDOM(html).window;

    // The four named sorts only. The two ▲/▼ arrows beside them already
    // spread req.query — they are what these four were brought into line
    // with — but they keep the page number, which is a separate question
    // from the one this describes.
    return Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        ".sorting-options a:not(.hover-scale)",
      ),
    ).map((a) => a.getAttribute("href")!);
  }

  it("keeps the search the visitor typed", async () => {
    const hrefs = await render({ search: "doom" });

    hrefs.forEach((href) => expect(href).toContain("search=doom"));
  });

  it("drops the page, which the new order invalidates", async () => {
    const hrefs = await render({ search: "doom", page: "7" });

    hrefs.forEach((href) => expect(href).not.toContain("page="));
  });

  it("still sets the sort it is there to set", async () => {
    const hrefs = await render({ search: "doom" });

    expect(hrefs[0]).toContain("orderBy=title");
    expect(hrefs[0]).toContain("orderDir=ASC");
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
