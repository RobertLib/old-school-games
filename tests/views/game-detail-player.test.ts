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
import { ORGANIZATION_REF, organizationNode } from "../../utils/organization.ts";

/**
 * Where the game page frames the DOS player from, in both arrangements.
 *
 * By default the player is /js-dos.html on this site, framed same-origin —
 * where, as utils/site.ts explains, the frame's sandbox is no boundary. With
 * PLAYER_ORIGIN set it is framed from an origin of its own, which is what
 * makes the same sandbox one. Both frames on the page have to follow the
 * setting: the one public/js/game-player.js builds from data-player-src, and
 * the <noscript> one a visitor without JavaScript gets. A frame left behind
 * on this origin would be the whole exposure back, for whoever sees it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

const PLAYER = "https://play.example.test";
const MEDIA_BUNDLE = "https://media.example/games/doom.jsdos";

function renderDetail(stream: string, playerOrigin?: string): Promise<string> {
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
      canonicalUrl: `${SITE_URL}/doom`,
      ldJson: { "@context": "https://schema.org", "@type": "VideoGame" },
      // What app.locals.asset does to the frame: a content hash in the query.
      asset: (file: string) =>
        file === "/js-dos.html" ? `${file}?v=0123456789` : file,
      // app.locals.playerOrigin is null when unset; undefined — a render with
      // no such local at all — has to mean the same thing.
      ...(playerOrigin === undefined ? {} : { playerOrigin }),
      siteUrl: SITE_URL,
      siteTitle: SITE_TITLE,
      siteDescription: SITE_DESCRIPTION,
      siteName: SITE_NAME,
      siteImage: SITE_IMAGE,
      siteImageWidth: SITE_IMAGE_WIDTH,
      siteImageHeight: SITE_IMAGE_HEIGHT,
      buildBreadcrumbs,
      isNoindex,
      genreLabel,
      genreInSentence,
      absoluteUrl,
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

/** Both frame addresses the page carries: the scripted one and the fallback. */
async function frames(
  stream: string,
  playerOrigin?: string,
): Promise<{ scripted: string; fallback: string }> {
  const html = await renderDetail(stream, playerOrigin);
  const { document } = new JSDOM(html).window;

  const scripted = document
    .querySelector(".game-detail-player")!
    .getAttribute("data-player-src")!;

  // The <noscript> frame is parsed as text when scripting is on, so it is
  // read out of the element's contents rather than queried for.
  const noscript = document.querySelector(".game-detail-player noscript")!;
  const fallback = new JSDOM(noscript.innerHTML).window.document
    .querySelector("iframe.game-detail-stream")!
    .getAttribute("src")!;

  return { scripted, fallback };
}

/** The ?stream= a frame address carries, decoded. */
function streamOf(address: string): string | null {
  return new URL(address, SITE_URL).searchParams.get("stream");
}

describe("the player frame on this site (PLAYER_ORIGIN unset)", () => {
  /**
   * The default is what the page did before the setting existed, to the
   * byte: a relative address, and the stored stream exactly as stored — a
   * path on this site stays a path, which the player resolves against the
   * origin it is on, and that is this one.
   */
  it.each([
    ["with no such local", undefined],
    ["with the local null", null as unknown as string],
  ])("frames /js-dos.html on this origin %s", async (_label, playerOrigin) => {
    const { scripted, fallback } = await frames("/bundles/doom.jsdos", playerOrigin);

    expect(scripted).toBe(
      "/js-dos.html?v=0123456789&stream=%2Fbundles%2Fdoom.jsdos",
    );
    expect(fallback).toBe(scripted);
  });
});

describe("the player frame on a player origin of its own", () => {
  it("frames the player origin from both frames", async () => {
    const { scripted, fallback } = await frames(MEDIA_BUNDLE, PLAYER);

    expect(scripted.startsWith(`${PLAYER}/js-dos.html?v=0123456789&`)).toBe(true);
    expect(fallback).toBe(scripted);
  });

  it("keeps a bundle from the media bucket as it is", async () => {
    const { scripted } = await frames(MEDIA_BUNDLE, PLAYER);

    expect(streamOf(scripted)).toBe(MEDIA_BUNDLE);
  });

  /**
   * A stream stored as a path on this site. Handed over as it is, the
   * player would resolve it against the origin it is on — the player's,
   * which serves nothing but the player — and the game would 404. It is
   * resolved against this site first, in both frames.
   */
  it.each(["/bundles/doom.jsdos", "bundles/doom.jsdos"])(
    "resolves %o against this site, not the player's origin",
    async (stored) => {
      const { scripted, fallback } = await frames(stored, PLAYER);

      expect(streamOf(scripted)).toBe(`${SITE_URL}/bundles/doom.jsdos`);
      expect(streamOf(fallback)).toBe(`${SITE_URL}/bundles/doom.jsdos`);
    },
  );

  // The same sandbox, which on a player origin keeps the player's origin.
  it("sandboxes the fallback frame exactly as before", async () => {
    const html = await renderDetail(MEDIA_BUNDLE, PLAYER);
    const { document } = new JSDOM(html).window;
    const noscript = document.querySelector(".game-detail-player noscript")!;
    const iframe = new JSDOM(noscript.innerHTML).window.document.querySelector(
      "iframe.game-detail-stream",
    )!;

    expect(iframe.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-pointer-lock",
    );
    expect(iframe.getAttribute("allow")).toBe("fullscreen; gamepad; autoplay");
  });
});
