import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import {
  breadcrumbLdJson,
  buildBreadcrumbs,
} from "../../utils/breadcrumbs.ts";
import { isNoindex } from "../../utils/indexability.ts";
import { genreInSentence, genreLabel } from "../../utils/genre-label.ts";
import { absoluteUrl } from "../../utils/site.ts";
import {
  MEDIA_ORIGIN,
  SITE_DESCRIPTION,
  SITE_IMAGE,
  SITE_TITLE,
  SITE_URL,
} from "../../utils/site.ts";

/**
 * The card X actually renders, which is decided by the image and not by the
 * tag that claims it.
 *
 * "summary_large_image" was hard-coded here for every page on the site. X
 * honours it only when the image is at least 300x157 and otherwise falls back
 * to the small card — or drops the picture altogether. The site's own fallback
 * image is 1200x630 and clears that easily; a game's cover does not. The art
 * in the media bucket is 150 pixels wide (150x195 for Might and Magic, 150x205
 * for Space Quest I, 150x207 for Ultima IV), so the declaration was wrong on
 * precisely the pages that get linked to.
 *
 * The comment on twitter:image in views/head.ejs had already worked this out
 * once, for a 180x180 fallback it replaced — and then excused the game pages
 * in its last sentence, which is where the bug lived on. That is the reason
 * this is a test and not another paragraph: the numbers are in the bucket, not
 * in the repository, so nothing in a review would have caught the declaration
 * drifting away from them.
 *
 * If the covers are ever re-scanned at 600 wide or more, this suite is what
 * should fail — and the fix is then to collapse head.ejs back to one string.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

function renderHead(locals: Record<string, unknown> = {}): Promise<string> {
  return ejs.renderFile(
    path.join(VIEWS, "head.ejs"),
    {
      asset: (file: string) => file,
      siteUrl: SITE_URL,
      siteTitle: SITE_TITLE,
      siteDescription: SITE_DESCRIPTION,
      siteImage: SITE_IMAGE,
      mediaOrigin: MEDIA_ORIGIN,
      buildBreadcrumbs,
      isNoindex,
      genreLabel,
      genreInSentence,
      absoluteUrl,
      breadcrumbLdJson,
      csrfToken: "t",
      cspNonce: "n",
      req: { path: "/", originalUrl: "/", query: {}, params: {} },
      ...locals,
    },
    { root: VIEWS, views: [VIEWS] },
  );
}

function meta(html: string, name: string): string | null {
  const { document } = new JSDOM(html).window;

  return document
    .querySelector(`meta[name="${name}"]`)
    ?.getAttribute("content") ?? null;
}

const COVER = `${MEDIA_ORIGIN}/storage/v1/object/public/assets/doom/doom-cover.webp`;

describe("the Twitter card type", () => {
  it("is the large card when the page falls back to the site image", async () => {
    const html = await renderHead();

    expect(meta(html, "twitter:card")).toBe("summary_large_image");
    expect(meta(html, "twitter:image")).toBe(SITE_IMAGE);
  });

  /**
   * A game page hands down its cover as `image`, and every cover in the bucket
   * is 150 wide — under half of what X wants before it will draw a large card.
   */
  it("is the small card when the page supplies a game cover", async () => {
    const html = await renderHead({ image: COVER });

    expect(meta(html, "twitter:card")).toBe("summary");
    expect(meta(html, "twitter:image")).toBe(COVER);
  });

  /**
   * The switch has to be the one views/og-image.ejs turns, or the two tags can
   * end up describing different pictures: that partial states og:image:width
   * and og:image:height only when there is no `locals.image`, which is exactly
   * the case where the 1200x630 constant is what gets served.
   */
  it("agrees with og-image.ejs about which image is in play", async () => {
    const partial = path.join(VIEWS, "og-image.ejs");

    const renderPartial = (locals: Record<string, unknown>) =>
      ejs.renderFile(
        partial,
        {
          siteTitle: SITE_TITLE,
          siteImage: SITE_IMAGE,
          siteImageWidth: 1200,
          siteImageHeight: 630,
          siteUrl: SITE_URL,
          title: SITE_TITLE,
          absoluteUrl,
          ...locals,
        },
        { root: VIEWS, views: [VIEWS] },
      );

    // The cover is the case with no stated dimensions, and the case the small
    // card is for; the site image states them, and gets the large card. Both
    // halves read `locals.image`, so they cannot come apart.
    expect(await renderPartial({ image: COVER, title: "Doom" })).not.toContain(
      "og:image:width",
    );
    expect(await renderPartial({})).toContain("og:image:width");
  });

  /**
   * validations/games.ts accepts a cover given as a path on this site, which
   * the page's <img> resolves and a scraper does not: a relative og:image or
   * twitter:image is simply no image. Both tags state the absolute address.
   */
  it("states a cover stored as a path on this site as an absolute address", async () => {
    const html = await renderHead({ image: "/images/doom.png" });

    expect(meta(html, "twitter:image")).toBe(`${SITE_URL}/images/doom.png`);

    const og = await ejs.renderFile(
      path.join(VIEWS, "og-image.ejs"),
      {
        siteTitle: SITE_TITLE,
        siteImage: SITE_IMAGE,
        siteImageWidth: 1200,
        siteImageHeight: 630,
        siteUrl: SITE_URL,
        title: "Doom",
        image: "/images/doom.png",
        absoluteUrl,
      },
      { root: VIEWS, views: [VIEWS] },
    );

    expect(og).toContain(
      `<meta property="og:image" content="${SITE_URL}/images/doom.png" />`,
    );
  });

  /**
   * The alt text is written from the title and has to survive the split, since
   * a card with a picture and nothing describing it is what a screen reader on
   * X announces as an unlabelled attachment.
   */
  it("keeps the image labelled on both cards", async () => {
    for (const locals of [{}, { image: COVER, title: "Doom" }]) {
      const html = await renderHead(locals);

      expect(meta(html, "twitter:image:alt")).not.toBe("");
      expect(meta(html, "twitter:image:alt")).not.toBeNull();
    }
  });
});
