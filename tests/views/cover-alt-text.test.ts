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
import {
  SITE_DESCRIPTION,
  SITE_IMAGE,
  SITE_IMAGE_HEIGHT,
  SITE_IMAGE_WIDTH,
  SITE_NAME,
  SITE_TITLE,
  SITE_URL,
} from "../../utils/site.ts";
import { ORGANIZATION_REF, organizationNode } from "../../utils/organization.ts";

/**
 * What the artwork on this site calls itself.
 *
 * Every cover used to carry the bare game title as its alt, which was the
 * weaker answer on both counts it is judged by.
 *
 * For image search, the alt is essentially all the text Google has for a file
 * whose own name is a bucket id — and routes/sitemap.ts submits every one of
 * these through the image sitemap extension, so this sentence is the caption
 * on the entire visual half of the catalogue. "Doom" names a game; "Doom –
 * MS-DOS cover art" names the picture, which is the thing being indexed.
 *
 * For a screen reader it is often the link text: in views/games/game-item.ejs
 * and views/lists/most-played.ejs the cover sits in an <a> of its own,
 * immediately below a second <a> holding the title and pointing at the same
 * address, so the card announced two adjacent links both reading "Doom".
 *
 * The point of checking it here rather than in any one view is that the value
 * has to be the *same* everywhere. One picture described two ways is the
 * failure views/og-image.ejs and views/head.ejs were reorganised to prevent
 * for og:image and twitter:image, and the gallery had already drifted into
 * exactly it — see the render test at the bottom.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

const COVER_SUFFIX = "– MS-DOS cover art";

/**
 * Every <img> in a template, as written.
 *
 * The obvious `<img\s[^>]*>` does not work on an EJS template and fails
 * silently rather than loudly: an attribute value here is usually `<%= … %>`,
 * so the first ">" the scan meets is the one closing the interpolation, and
 * every tag comes back truncated before it reaches src. Ending on a ">" that
 * is not preceded by "%" is what distinguishes the two.
 */
function imgTags(source: string): string[] {
  return [...source.matchAll(/<img\s[\s\S]*?(?<!%)>/gi)].map(
    (match) => match[0],
  );
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag);

  return match ? match[1]! : null;
}

/**
 * The covers, picked out by what they point at.
 *
 * A cover is the one image on this site whose src is a `.cover` field —
 * screenshots come out of the `images` array and are captioned differently on
 * purpose. Selecting on the source rather than on a hand-kept list of files
 * means a view added later is covered the day it is written.
 */
const coverTags: [string, string][] = globSync("views/**/*.ejs").flatMap(
  (file) =>
    imgTags(readFileSync(file, "utf-8"))
      .filter((tag) => /\.cover\s*%>/.test(attr(tag, "src") ?? ""))
      .map((tag): [string, string] => [file, tag]),
);

describe("cover artwork", () => {
  it("finds the covers to check", () => {
    // Six today — the listing card, most-played, the carousel, Game of the
    // Week, similar games and the detail page. A floor rather than the
    // number, so adding a view does not fail this on its own.
    expect(coverTags.length).toBeGreaterThanOrEqual(6);
  });

  it.each(coverTags)("%s describes its cover as artwork", (_file, tag) => {
    expect(attr(tag, "alt")).toMatch(
      new RegExp(`%>\\s*${COVER_SUFFIX}$`),
    );
  });

  /**
   * The title still has to be in there. The suffix alone would describe every
   * cover on a 25-card listing identically, which for image search is the
   * same as describing none of them.
   */
  it.each(coverTags)("%s names the game in that alt", (_file, tag) => {
    expect(attr(tag, "alt")).toMatch(/<%=\s*[\w.]*\btitle\s*%>/);
  });
});

/**
 * The gallery, rendered for real.
 *
 * Worth its own render rather than a source scan for two reasons. The alt
 * here is the one on the site that is computed rather than written inline, so
 * reading the template tells you nothing about what comes out of it. And the
 * route tests that cover this page (tests/routes/home.test.ts) mock
 * res.render and assert the view name, so until this test the template was
 * never compiled by anything — a syntax error in it would have reached
 * production.
 *
 * What is being pinned is agreement with views/games/game-detail.ejs, which
 * is where the link into this page comes from. That page captions a thumbnail
 * "screenshot <index>" using the array index, and passes the same index in the
 * /gallery/:index address; the gallery counted from one instead and said
 * "Image <index + 1>". So every screenshot on the site had two names and two
 * numbers, one on each side of a single click. Slot 0 is the cover, which the
 * detail page skips but the gallery's Previous button walks back onto.
 */
function renderGallery(currentIndex: number): Promise<string> {
  const game = {
    id: 1,
    title: "Doom",
    slug: "doom",
    genre: "ACTION",
    images: ["/cover.png", "/shot-1.png", "/shot-2.png"],
  };

  return ejs.renderFile(
    path.join(VIEWS, "games/game-gallery.ejs"),
    {
      game,
      image: game.images[currentIndex],
      currentIndex,
      title: "Doom - Gallery - OldSchoolGames",
      description: "Screenshots from Doom.",
      canonicalUrl: `${SITE_URL}/doom`,
      noindex: true,
      asset: (file: string) => file,
      siteUrl: SITE_URL,
      siteTitle: SITE_TITLE,
      siteDescription: SITE_DESCRIPTION,
      siteName: SITE_NAME,
      siteImage: SITE_IMAGE,
      siteImageWidth: SITE_IMAGE_WIDTH,
      siteImageHeight: SITE_IMAGE_HEIGHT,
      buildBreadcrumbs,
      isNoindex,
      breadcrumbLdJson,
      organizationNode,
      organizationRef: ORGANIZATION_REF,
      csrfToken: "t",
      cspNonce: "n",
      req: {
        path: `/doom/gallery/${currentIndex}`,
        originalUrl: `/doom/gallery/${currentIndex}`,
        query: {},
        params: {},
        session: {},
      },
    },
    { root: VIEWS, views: [VIEWS] },
  );
}

async function galleryAlt(currentIndex: number): Promise<string | null> {
  const { document } = new JSDOM(await renderGallery(currentIndex)).window;

  return document
    .querySelector<HTMLImageElement>("#galleryImage")!
    .getAttribute("alt");
}

describe("gallery slide alt text", () => {
  it("calls slot 0 the cover, as the rest of the site does", async () => {
    expect(await galleryAlt(0)).toBe(`Doom ${COVER_SUFFIX}`);
  });

  it.each([1, 2])(
    "numbers slot %i the way the detail page links it",
    async (index) => {
      expect(await galleryAlt(index)).toBe(`Doom – screenshot ${index}`);
    },
  );

  /**
   * The detail page's own caption for the same file, so the two cannot drift
   * apart again without one of these failing.
   */
  it("matches the caption game-detail.ejs writes for that file", () => {
    const detail = readFileSync(
      path.join(VIEWS, "games/game-detail.ejs"),
      "utf-8",
    );

    expect(detail).toContain(
      'alt="<%= game.title %> – screenshot <%= index %>"',
    );
  });
});
