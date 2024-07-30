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
 * The picture a shared link carries is described twice — og:image:alt for
 * Facebook, LinkedIn, Slack and Discord, twitter:image:alt for X — and the
 * two are meant to be one sentence. views/head.ejs says so beside the Twitter
 * half ("the two cannot describe the one image differently"), and
 * tests/views/meta-tags.test.ts checks that both are written from the same
 * expression, `locals.title || siteTitle`.
 *
 * The same expression is not the same value when the two partials are handed
 * different locals, and on six pages they were. Each of these declares its
 * own title as a template const and passes it to head.ejs explicitly — the
 * repair the comment on twitter:title in head.ejs describes — and then
 * included views/og-image.ejs with nothing. A const in the including template
 * is never a property of the data a partial receives, so og-image.ejs fell
 * back to the site's name while the Twitter tag named the page: "OldSchoolGames
 * – Play classic MS-DOS games…" on one card and "404 - Page Not Found -
 * OldSchoolGames" on the other, for one picture.
 *
 * Rendered for real, because a text check can only see that an include has an
 * argument, not what the partial made of it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

/** Every view that names its own title rather than taking one from a route. */
const PAGES = [
  "400.ejs",
  "403.ejs",
  "404.ejs",
  "500.ejs",
  "profile.ejs",
  "auth/login.ejs",
];

/** What app.ts puts on app.locals, and what a request carries. */
function render(file: string): Promise<string> {
  return ejs.renderFile(
    path.join(VIEWS, file),
    {
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
      genreLabel,
      genreInSentence,
      absoluteUrl,
      csrfToken: "t",
      cspNonce: "n",
      searchQuery: "",
      // The renderers of all six pass this — see views/403.ejs.
      noindex: true,
      req: {
        path: "/nowhere",
        originalUrl: "/nowhere",
        query: {},
        params: {},
        session: {},
      },
    },
    { root: VIEWS, views: [VIEWS] },
  );
}

function content(document: Document, selector: string): string | null {
  return document.querySelector(selector)?.getAttribute("content") ?? null;
}

describe("the alt text on a page's share image", () => {
  it.each(PAGES)(
    "%s describes the image the same way on both cards",
    async (file) => {
      const { document } = new JSDOM(await render(file)).window;

      const og = content(document, 'meta[property="og:image:alt"]');
      const twitter = content(document, 'meta[name="twitter:image:alt"]');

      expect(og).not.toBeNull();
      expect(og).toBe(twitter);
    },
  );

  // And the sentence both of them settle on is the page's own title, which is
  // what the image is of — not the site's name, which is what the Open Graph
  // half fell back to.
  it.each(PAGES)("%s names the page it is on", async (file) => {
    const { document } = new JSDOM(await render(file)).window;

    const title = document.querySelector("title")?.textContent?.trim();

    expect(title).toBeTruthy();
    expect(title).not.toBe(SITE_TITLE);
    expect(content(document, 'meta[property="og:image:alt"]')).toBe(title);
  });
});
