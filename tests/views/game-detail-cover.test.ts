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
 * How a game page asks for its cover.
 *
 * The hint is easy to lose and impossible to miss the loss of: .game-hero
 * sets the cover as an inline `background-image`, which a browser cannot
 * discover until the stylesheet has been fetched, parsed and matched — so
 * without the preload the largest element on the page starts downloading a
 * round trip after everything else, and nothing anywhere reports it. Only a
 * field measurement of LCP would, months later.
 *
 * The <img> further down names the same file, so the two share one fetch;
 * that is why it is eager rather than lazy, and why eager costs no second
 * request.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

const COVER = "https://media.example/doom.png";

function renderDetail(cover: string): Promise<string> {
  const game = {
    id: 1,
    title: "Doom",
    slug: "doom",
    genre: "ACTION",
    release: 1993,
    developer: "id Software",
    publisher: "GT Interactive",
    description: "<p>Classic FPS.</p>",
    cover,
    images: cover ? [cover] : [],
    stream: "doom.jsdos",
    manual: "",
    averageRating: 4.5,
    ratingCount: 10,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
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
      image: cover,
      canonicalUrl: `${SITE_URL}/doom`,
      ldJson: {
        "@context": "https://schema.org",
        "@type": "VideoGame",
        name: "Doom",
      },
      playerFrame: "/js-dos.html",
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
        path: "/doom",
        originalUrl: "/doom",
        query: {},
        params: {},
        session: {},
      },
      searchQuery: "",
      sidebarGenres: ["ACTION"],
      recentComments: [],
      discussedGames: [],
      topRatedGames: [],
      favoriteGames: [],
    },
    { root: VIEWS, views: [VIEWS] },
  );
}

describe("game detail cover", () => {
  it("preloads the cover the hero paints", async () => {
    const { document } = new JSDOM(await renderDetail(COVER)).window;

    const preload = document.querySelector<HTMLLinkElement>(
      'link[rel="preload"][as="image"]',
    );

    expect(preload).not.toBeNull();
    expect(preload!.getAttribute("href")).toBe(COVER);
    // Preloaded images default to the same low priority as the rest of the
    // page's artwork, which defeats the point of hinting this one.
    expect(preload!.getAttribute("fetchpriority")).toBe("high");

    // The same file, so the hint and the element share one request.
    expect(document.querySelector(".game-hero-background")).not.toBeNull();
  });

  it("does not defer an image inside the first screen", async () => {
    const { document } = new JSDOM(await renderDetail(COVER)).window;

    const img = document.querySelector<HTMLImageElement>(
      "img.game-detail-initial",
    );

    expect(img).not.toBeNull();
    expect(img!.getAttribute("loading")).toBe("eager");
    expect(img!.getAttribute("src")).toBe(COVER);
  });

  it("hints nothing for a game with no cover", async () => {
    const { document } = new JSDOM(await renderDetail("")).window;

    // A preload naming the empty string is a request for the page itself.
    expect(
      document.querySelector('link[rel="preload"][as="image"]'),
    ).toBeNull();
    expect(document.querySelector("img.game-detail-initial")).toBeNull();
  });
});
