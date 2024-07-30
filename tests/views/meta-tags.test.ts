import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.resolve(__dirname, "../../views");

const HEAD = readFileSync(path.join(VIEWS_DIR, "head.ejs"), "utf-8");

/**
 * A view is a whole page if it pulls in head.ejs; everything else under
 * views/ is a partial that renders into one.
 *
 * Globbed from VIEWS_DIR and joined back onto it, rather than as the pattern
 * "views/**\/*.ejs". globSync resolves a relative pattern against
 * process.cwd(), which is the directory vitest happened to be started from —
 * so run from anywhere but the project root this matched nothing, and every
 * it.each below silently became zero cases. Only the "has pages to check"
 * guard would have caught it, and only because it exists. VIEWS_DIR is
 * derived from this file's own location, which is fixed whatever the CWD is,
 * for the same reason utils/logger.ts derives its ROOT_DIR that way.
 */
const pages = globSync("**/*.ejs", { cwd: VIEWS_DIR })
  .map((file) => path.join(VIEWS_DIR, file))
  .filter((file) =>
    /include\(\s*['"](?:\.\.\/)*head['"]/.test(readFileSync(file, "utf-8")),
  );

/** What the browser actually receives: the page plus the head it includes. */
function rendered(file: string): string {
  return `${HEAD}\n${readFileSync(file, "utf-8")}`;
}

function countMeta(html: string, name: string): number {
  const pattern = new RegExp(`<meta\\s+name="${name}"`, "gi");

  return [...html.matchAll(pattern)].length;
}

/**
 * Checked here rather than made impossible, because it cannot be made
 * impossible cheaply.
 *
 * <meta name="description"> is the one <head> tag that is not in head.ejs: it
 * is written out in each full-page view instead, twenty-five copies of it.
 *
 * Eight of these pages used to declare their title and description as a
 * template `const` *after* the include, where an included template cannot see
 * them — so head.ejs served those eight the site's generic blurb in the
 * Twitter card while the page's own title sat two lines below. They declare
 * the pair above the include now and pass it down explicitly, which is what
 * "%s agrees with head.ejs about its own title" further down holds them to.
 *
 * So the copies stay and this keeps them honest, the way
 * tests/utils/reserved-slugs.test.ts keeps its hand-kept list honest against
 * the live enum. What a new page can no longer do is ship without the tag, or
 * with two of them — which is exactly what would happen on the day somebody
 * does move it into head.ejs and misses a view.
 */
describe("every page's <head>", () => {
  it("has pages to check", () => {
    // Twenty-five today. A floor, not the number, so adding a page does not
    // fail this on its own.
    expect(pages.length).toBeGreaterThanOrEqual(20);
  });

  it.each(pages)("%s has exactly one meta description", (file) => {
    expect(countMeta(rendered(file), "description")).toBe(1);
  });

  it.each(pages)("%s gives that description a value", (file) => {
    const html = readFileSync(file, "utf-8");
    const match = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html);

    expect(match).not.toBeNull();
    expect(match![1]!.trim()).not.toBe("");
  });

  it.each(pages)("%s sets exactly one title", (file) => {
    const titles = [...rendered(file).matchAll(/<title>/gi)];

    expect(titles).toHaveLength(1);
  });

  /**
   * head.ejs carries these for every page, so a view repeating one would send
   * the browser two conflicting values for it.
   */
  it.each(pages)("%s does not repeat what head.ejs already sets", (file) => {
    const own = readFileSync(file, "utf-8");

    for (const name of ["viewport", "csrf-token", "twitter:card"]) {
      expect(countMeta(own, name)).toBe(0);
    }

    expect(own).not.toContain("<meta charset");
    expect(own).not.toContain('rel="canonical"');
  });

  /**
   * The robots tag belongs to head.ejs alone, and this is what holds it
   * there.
   *
   * Five views used to write one themselves. That reads as a harmless
   * duplicate until you notice what sits ten lines below it in head.ejs: the
   * canonical tag, suppressed on anything head.ejs knows to be noindex. A tag
   * written in the view is a tag head.ejs cannot see, so those five pages
   * asked not to be indexed and named a canonical in the same breath — and
   * views/games/game-gallery.ejs named a *different* address, the game page,
   * which is the one pairing Google calls conflicting: the canonical says
   * "index that one instead", the noindex says "index nothing".
   *
   * Routing the decision through `locals.noindex` is what makes the two agree
   * by construction, and it only holds while this is the only writer.
   */
  it.each(pages)("%s leaves the robots tag to head.ejs", (file) => {
    expect(countMeta(readFileSync(file, "utf-8"), "robots")).toBe(0);
  });

  /**
   * Two now, not one: head.ejs writes a robots tag on every page, and which
   * of the two it is depends on the branch.
   *
   * The count is what matters. Both tags live in the same if/else on one
   * `noindex`, so exactly one of them can ever reach a response — and a third
   * appearing here would mean somebody had written a tag outside that pair,
   * which is the single thing this whole block exists to prevent.
   */
  it("still writes a robots tag, in head.ejs", () => {
    expect(countMeta(HEAD, "robots")).toBe(2);
  });

  /**
   * The indexable branch, which used to emit nothing at all.
   *
   * An absent robots tag is not a neutral position: it leaves a crawler on
   * defaults that differ by jurisdiction, and the one that bites here is
   * max-image-preview. Under Article 15 of the EU Copyright Directive Google
   * shows EU users a thumbnail unless the site opts in by name — on a .eu
   * catalogue of cover art and screenshots that publishes an image sitemap,
   * that was the whole visual half of the site being shown small to its own
   * audience.
   *
   * Asserted as a literal rather than by matching the directive names, so
   * that dropping one is a failure rather than a quietly weaker tag.
   */
  it("opts an indexable page into full-size previews", () => {
    expect(HEAD).toContain(
      '<meta name="robots" content="max-image-preview:large, max-snippet:-1" />',
    );
  });

  /**
   * The trap this exists to keep shut.
   *
   * head.ejs writes twitter:title and twitter:description from `locals`, with
   * the site's own name and blurb behind them as a fallback. Most views never
   * touch that: their route hands the pair down, so `locals.title` is set
   * before the partial runs and the card matches the <title> beside it.
   *
   * Eight views wrote their own instead — the four error pages, /profile,
   * /login and the two game forms — and wrote them like this:
   *
   *     <%- include('head') %>
   *     <% const title = '404 - Page Not Found - OldSchoolGames' %>
   *
   * Which fails twice over. A `const` in the including template is a variable
   * in that template's compiled function and never a property of the data
   * object passed down, so head.ejs could not have read it wherever it sat;
   * and it is declared after the include has already rendered besides. Every
   * one of those pages therefore advertised "OldSchoolGames" as its Twitter
   * title while its real one sat two lines below, and the same for the
   * description and for twitter:image:alt, which is built from `title` too.
   *
   * Nothing was lost while it lasted — all eight are noindex, and their og:
   * tags are written after the const and were always right. It is held here
   * because it is a trap rather than a bug: it is invisible in the view, it
   * costs nothing until one of those pages becomes indexable, and the obvious
   * repair (moving the const up) fixes only half of it.
   *
   * So both halves are asserted. A view may leave the pair to its route, but
   * if it declares either one itself then the declaration must come before
   * the include and must be handed down through it.
   */
  const INCLUDE_HEAD =
    /include\(\s*['"](?:\.\.\/)*head['"]\s*(?:,\s*\{([^}]*)\})?\s*\)/;

  it.each(pages)("%s agrees with head.ejs about its own title", (file) => {
    const own = readFileSync(file, "utf-8");
    const include = INCLUDE_HEAD.exec(own);

    expect(include).not.toBeNull();

    for (const name of ["title", "description"]) {
      const declaration = new RegExp(`<%\\s*const\\s+${name}\\s*=`).exec(own);

      // Nothing declared: the route passes it, which is the common case and
      // the one head.ejs was written for.
      if (!declaration) continue;

      expect(declaration.index).toBeLessThan(include!.index);
      expect(include![1] ?? "").toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});

/**
 * The three things that used to be written out per view, and what holds each
 * of them in one place now.
 *
 * All three were the same failure: a value copied into twenty-odd templates
 * drifts, and every one of these had. The og:image was an undersized file
 * below the floor of every consumer it was handed to; the Organization node
 * existed three times under two names, only one copy carrying an `@id`, so a
 * consumer read three publishers for one site; and four pages drew a
 * breadcrumb in their own markup, which left views/head.ejs emitting no
 * BreadcrumbList for a page that was showing the reader a trail.
 */
describe("what no single view may write for itself", () => {
  // With or without a data argument: the views that declare their own title
  // hand it to this partial as well as to head.ejs — see the case further
  // down about the image's alt text.
  const OG_IMAGE_PARTIAL =
    /include\(\s*['"](?:\.\.\/)*og-image['"]\s*(?:,\s*\{([^}]*)\})?\s*\)/;

  it.each(pages)("%s gets its og:image from the partial", (file) => {
    const own = readFileSync(file, "utf-8");

    // Whatever a page does, it must not write these four itself: the partial
    // decides the URL, whether a width/height pair may go with it (only the
    // site's own image has a size known here), and the alt text that describes
    // it. See views/og-image.ejs.
    expect(own).not.toMatch(/<meta\s+property="og:image"/i);
    expect(own).not.toMatch(/<meta\s+property="og:image:(width|height)"/i);

    // views/games/game-detail.ejs was the one view that wrote its own, which
    // is why it was also the only page whose shared link carried a described
    // picture. head.ejs has emitted the Twitter half on every page throughout.
    expect(own).not.toMatch(/<meta\s+property="og:image:alt"/i);

    // Declaring Open Graph at all is what obliges a page to carry an image:
    // a card with a title and no picture is the one outcome worth avoiding.
    // The four admin forms — views/news/new-news.ejs and edit-news.ejs, and
    // views/games/new-game.ejs and edit-game.ejs — declare none, and they are
    // the reason this is conditional rather than absolute. All four sit behind
    // isAuth+isAdmin, so nobody can reach one to share it and no scraper
    // following a pasted link gets anything but the login page.
    //
    // The two game forms used to declare the block anyway, and carried the
    // proof that nothing consumed it: edit-game.ejs named "/games/edit" as its
    // og:url, which this router has never answered. See the comment in
    // new-game.ejs.
    if (/<meta\s+property="og:title"/i.test(own)) {
      expect(own).toMatch(OG_IMAGE_PARTIAL);
    }
  });

  it("still writes an og:image:alt, in the partial", () => {
    const partial = readFileSync(path.join(VIEWS_DIR, "og-image.ejs"), "utf-8");

    expect(partial).toMatch(/<meta\s+property="og:image:alt"/i);
  });

  /**
   * The two tags describe one picture, so they must not describe it
   * differently. head.ejs builds twitter:image:alt from `locals.title` with
   * the site title behind it; views/og-image.ejs takes the same expression.
   */
  it("describes that image the same way the Twitter card does", () => {
    const partial = readFileSync(path.join(VIEWS_DIR, "og-image.ejs"), "utf-8");
    const value = /property="og:image:alt"\s+content="([^"]*)"/i.exec(partial);
    const twitter = /name="twitter:image:alt"\s+content="([^"]*)"/i.exec(HEAD);

    expect(value).not.toBeNull();
    expect(twitter).not.toBeNull();
    expect(value![1]).toBe(twitter![1]);
  });

  /**
   * The same expression is only the same value when both partials are handed
   * the same `title`, and six views handed it to one of them. The error pages,
   * /profile and /login declare their title as a template const and pass it
   * down to head.ejs — the repair described in the case above about head.ejs —
   * but included og-image.ejs bare, and a const in the including template is
   * never part of the data a partial receives. So og:image:alt fell back to
   * the site's name while twitter:image:alt named the page: one picture, two
   * descriptions. tests/views/share-image-alt.test.ts renders all six.
   */
  it.each(pages)("%s hands its own title to og-image.ejs too", (file) => {
    const own = readFileSync(file, "utf-8");
    const include = OG_IMAGE_PARTIAL.exec(own);
    const declaration = /<%\s*const\s+title\s*=/.exec(own);

    // No share image at all, or a title that comes from the route and is in
    // `locals` for every partial alike.
    if (!include || !declaration) return;

    expect(declaration.index).toBeLessThan(include.index);
    expect(include[1] ?? "").toMatch(/\btitle\b/);
  });

  it.each(pages)("%s names no undersized share image", (file) => {
    // 180x180, and the one file that used to be every page's og:image,
    // twitter:image and NewsArticle image at once. Nothing should reach for
    // it again — tests/public-assets.test.ts guards the sizes of the two
    // files that replaced it.
    expect(readFileSync(file, "utf-8")).not.toContain("navbar.webp");
  });

  it.each(pages)("%s does not describe the site's publisher itself", (file) => {
    const own = readFileSync(file, "utf-8");

    // The site's own Organization is the node keyed on this anchor, and
    // utils/organization.ts is the only thing that may write it — as the node
    // (organizationNode) or as a reference to it (organizationRef). A view
    // spelling the anchor out by hand is how the three copies that used to
    // exist drifted into two names and two logos.
    //
    // Not a ban on "@type": "Organization" outright: views/games/developers.ejs
    // and publishers.ejs list the studios themselves as Organizations, which
    // is what those entities are, and has nothing to do with the publisher of
    // the site.
    expect(own).not.toContain("#organization");
  });

  it.each(pages)("%s draws no breadcrumb of its own", (file) => {
    const own = readFileSync(file, "utf-8");

    // views/breadcrumb.ejs and the BreadcrumbList in head.ejs are built from
    // one array — either buildBreadcrumbs(locals) or the `breadcrumbs` a
    // route passes. Markup written here has no counterpart in the schema,
    // which is exactly what /game-lists, /most-played, every curated list and
    // the comment overview shipped.
    expect(own).not.toMatch(/aria-label="breadcrumb"/i);
  });
});

/**
 * og:type has to be one of the object types the Open Graph protocol defines,
 * and every game page on the site declared one that is not: "video.game". The
 * video vertical is movie, episode, tv_show and other; there is no game. A
 * consumer that does not recognise the type is left to guess what the page
 * is, which is the one question the tag exists to answer.
 */
describe("Open Graph object types", () => {
  const OG_TYPES = new Set([
    "website",
    "article",
    "book",
    "profile",
    "music.song",
    "music.album",
    "music.playlist",
    "music.radio_station",
    "video.movie",
    "video.episode",
    "video.tv_show",
    "video.other",
  ]);

  it.each(pages)("%s declares a type the protocol defines", (file) => {
    const own = readFileSync(file, "utf-8");
    const types = [
      ...own.matchAll(/<meta\s+property="og:type"\s+content="([^"]*)"/gi),
    ].map((match) => match[1]);

    for (const type of types) {
      expect(OG_TYPES.has(type!), `${type} is not an Open Graph type`).toBe(
        true,
      );
    }
  });
});

/**
 * The tags that dress the site up outside the page itself — the browser
 * chrome's colour, the home-screen icon, and the manifest naming both again
 * for an installed window.
 *
 * None of them is a ranking signal. They are guarded because each fails
 * silently and invisibly to the person who broke it: a phone simply shows a
 * white address bar above a dark blue page, or takes a screenshot of it for
 * the home screen, and nothing in a test run or a deploy log says so.
 */
describe("head.ejs — chrome, icon and manifest", () => {
  it("colours the browser chrome", () => {
    expect(HEAD).toMatch(
      /<meta name="theme-color" content="#[0-9a-f]{6}" \/>/i,
    );
  });

  /**
   * The server cannot know the visitor's theme — it is in localStorage — so
   * the tag ships as the classic palette and theme-switcher.js corrects it
   * before paint. That script reaches for the element by name, so the parser
   * has to have passed it by the time the script runs.
   */
  it("emits the tag above the script that rewrites it", () => {
    const meta = HEAD.indexOf('name="theme-color"');
    // The element, not the filename: the comment explaining all this names
    // the script too, and prose about a tag is not one.
    const script = /<script\b[^>]*theme-switcher\.js/.exec(HEAD)?.index ?? -1;

    expect(meta).toBeGreaterThan(-1);
    expect(script).toBeGreaterThan(-1);
    expect(meta).toBeLessThan(script);
  });

  /**
   * And the value it ships has to be the palette it claims to be, or the
   * chrome is a shade off the navbar until the script runs.
   */
  it("ships the classic palette's own background colour", () => {
    const stylesheet = readFileSync(
      path.resolve(__dirname, "../../public/css/style.css"),
      "utf-8",
    );

    // :root, not one of the html.theme-… blocks: that is the default palette,
    // which is what a response with no theme applied yet renders as.
    const root = /:root \{([\s\S]*?)\}/.exec(stylesheet)?.[1];
    const background = /--nc-bg:\s*(#[0-9a-f]{6})/i.exec(root ?? "")?.[1];
    const declared = /<meta name="theme-color" content="(#[0-9a-f]{6})"/i.exec(
      HEAD,
    )?.[1];

    expect(background).toBeDefined();
    expect(declared?.toLowerCase()).toBe(background?.toLowerCase());
  });

  it("gives iOS an icon rather than letting it screenshot the page", () => {
    expect(HEAD).toContain('<link rel="apple-touch-icon"');
  });

  it("links the manifest", () => {
    expect(HEAD).toContain('rel="manifest" href="/site.webmanifest"');
  });
});
