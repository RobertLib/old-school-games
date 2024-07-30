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
import {
  MEDIA_ORIGIN,
  SITE_DESCRIPTION,
  SITE_IMAGE,
  SITE_TITLE,
  SITE_URL,
} from "../../utils/site.ts";

/**
 * The handshake to the media bucket, started before the parser finds the
 * first cover.
 *
 * Every image on the site — covers and screenshots both — is served from a
 * different origin, so the first one costs a DNS lookup, a TCP connection and
 * a TLS negotiation before a byte of it can move. A game page preloads its
 * cover and opens that connection as a side effect; the listing pages had
 * nothing, and waited for the parser to reach an <img> a navbar, a sidebar
 * and a couple of hundred lines of markup in. The wait lands on the largest
 * image in the viewport, which is what Largest Contentful Paint measures, and
 * nothing reports it — the page is simply slower than it needs to be.
 *
 * Worth a test rather than a comment for the same reason the cover preload is
 * (see tests/views/game-detail-cover.test.ts): a hint nothing renders is a
 * hint whose absence is invisible.
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
      breadcrumbLdJson,
      csrfToken: "t",
      cspNonce: "n",
      req: { path: "/", originalUrl: "/", query: {}, params: {} },
      ...locals,
    },
    { root: VIEWS, views: [VIEWS] },
  );
}

function preconnects(html: string): HTMLLinkElement[] {
  const { document } = new JSDOM(html).window;

  return [
    ...document.querySelectorAll<HTMLLinkElement>('link[rel="preconnect"]'),
  ];
}

const GAME = { slug: "doom", title: "Doom", cover: "x", images: ["x"] };

describe("the media-origin preconnect", () => {
  it("is emitted on a listing page", async () => {
    const links = preconnects(await renderHead({ games: [GAME] }));

    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe(MEDIA_ORIGIN);
  });

  it("is emitted on a game page", async () => {
    const links = preconnects(await renderHead({ game: GAME }));

    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe(MEDIA_ORIGIN);
  });

  /**
   * A connection opened and never used is held idle and dropped, so the pages
   * that show no artwork should not ask for one: the legal pages, /about,
   * /how-to-play, /login, /profile and the error views all render text-only
   * sidebars.
   */
  it("is left off a page with no artwork on it", async () => {
    expect(preconnects(await renderHead())).toHaveLength(0);
  });

  it("is left off a listing that came back empty", async () => {
    expect(preconnects(await renderHead({ games: [] }))).toHaveLength(0);
  });

  /**
   * A plain <img src> is fetched in no-CORS mode, and browsers keep CORS and
   * non-CORS connections to one origin in separate pools. A preconnect
   * declared crossorigin would warm the pool the images never touch and leave
   * them to handshake again — the common way to write this tag and have it
   * do nothing at all.
   */
  it("does not declare crossorigin, which the images do not use", async () => {
    const link = preconnects(await renderHead({ game: GAME }))[0]!;

    expect(link.hasAttribute("crossorigin")).toBe(false);
  });

  /**
   * head.ejs is rendered here with a hand-written set of locals, and the
   * suite does the same in several other files. Reading mediaOrigin as a bare
   * name would make every one of those a ReferenceError out of the template
   * rather than an absent tag — the hazard views/right-sidebar.ejs documents
   * for its own locals.
   */
  it("renders without a mediaOrigin at all", async () => {
    const html = await renderHead({ game: GAME, mediaOrigin: undefined });

    expect(preconnects(html)).toHaveLength(0);
    expect(html).not.toContain('href=""');
  });
});
