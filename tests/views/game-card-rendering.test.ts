import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import Game from "../../models/game.ts";
import { sanitizeHtml } from "../../utils/sanitize-html.ts";
import {
  breadcrumbLdJson,
  buildBreadcrumbs,
} from "../../utils/breadcrumbs.ts";
import { isNoindex } from "../../utils/indexability.ts";
import { genreInSentence, genreLabel } from "../../utils/genre-label.ts";
import { absoluteUrl } from "../../utils/site.ts";
import {
  SITE_IMAGE,
  SITE_IMAGE_HEIGHT,
  SITE_IMAGE_WIDTH,
  SITE_NAME,
} from "../../utils/site.ts";
import { organizationNode } from "../../utils/organization.ts";

/**
 * The listing card, rendered for real.
 *
 * Same reasoning as tests/views/comment-rendering.test.ts: the route tests
 * mock res.render and assert locals, so nothing ever ran this template — and
 * that is precisely how it came to print raw "<br>" tags and double-escaped
 * ampersands at the reader. The card built its own blurb with
 * `description.replaceAll("<br />", "").slice(0, 250)`; DOMPurify writes a
 * line break as "<br>", so the replace matched nothing the admin form had
 * ever saved.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

/** A Game as the models hand one to a template. */
function game(description: string) {
  return new Game({
    id: 1,
    title: "Doom",
    slug: "doom",
    description,
    genre: "ACTION",
    release: 1993,
    developer: "id Software",
    publisher: "GT Interactive",
    images: [],
    stream: "",
    manual: "",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  } as any);
}

function renderCard(description: string) {
  return ejs.renderFile(
    path.join(VIEWS, "games/game-item.ejs"),
    { game: game(description), csrfToken: "t", req: {} },
    { root: VIEWS, views: [VIEWS] },
  );
}

/** What the reader actually sees, entities resolved once, as a browser does. */
function visibleText(html: string): string {
  const { document } = new JSDOM(html).window;

  return document.querySelector(".clearfix > div")!.textContent!.trim();
}

describe("game-item.ejs blurb", () => {
  // Both spellings, because the catalogue holds both: rows saved before the
  // current sanitizer carry the literal "<br />", everything saved through it
  // carries "<br>". The old template only ever handled the first.
  it.each([
    ["a<br>b", "a b"],
    ["a<br/>b", "a b"],
    ["a<br />b", "a b"],
    ["<p>Doom is great</p>", "Doom is great"],
    ["<b>Doom</b> rules", "Doom rules"],
  ])("flattens %j to %j", async (stored, expected) => {
    expect(visibleText(await renderCard(stored))).toBe(expected);
  });

  // A description holding markup has its "&" stored as "&amp;", and the
  // template escaped that a second time — the card read "Sam &amp; Max".
  it("shows an ampersand once, however it was stored", async () => {
    expect(visibleText(await renderCard(sanitizeHtml("<p>Sam & Max</p>")))).toBe(
      "Sam & Max",
    );
    expect(visibleText(await renderCard("Command & Conquer"))).toBe(
      "Command & Conquer",
    );
  });

  it("never shows a tag to the reader", async () => {
    const html = await renderCard(sanitizeHtml("<p>One</p><p>Two & three</p>"));

    expect(visibleText(html)).not.toMatch(/[<>]/);
  });

  // The template appended "..." to every card, including the ones it had not
  // truncated. truncateAtWord adds the ellipsis only when something was cut.
  it("adds no ellipsis to a description that fits", async () => {
    expect(visibleText(await renderCard("Short and sweet."))).toBe(
      "Short and sweet.",
    );
  });

  it("cuts a long description on a word boundary and marks it", async () => {
    const long = `${"word ".repeat(200)}end`;
    const shown = visibleText(await renderCard(long));

    expect(shown.endsWith("…")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(251);
    expect(shown).not.toContain("wor…");
  });

  it("renders an empty blurb rather than 'undefined' for a game with none", async () => {
    expect(visibleText(await renderCard(""))).toBe("");
  });
});

/**
 * The two other places a stored description reaches a reader as a blurb.
 *
 * Game#summary was introduced to fix the card above, and game-item.ejs and
 * the /collection JSON were moved onto it — these two were left behind on the
 * old `replaceAll("<br />", "")`, which is the bug this whole file documents.
 * The widget sits in the sidebar of every page and /most-played renders a
 * hundred rows of it, and neither had a test that rendered the template, so
 * nothing said so.
 */
describe("game-of-the-week.ejs blurb", () => {
  function renderWidget(description: string) {
    return ejs.renderFile(
      path.join(VIEWS, "game-of-the-week.ejs"),
      { gameOfTheWeek: { game: game(description) }, req: {} },
      { root: VIEWS, views: [VIEWS] },
    );
  }

  function widgetText(html: string): string {
    const { document } = new JSDOM(html).window;

    return document
      .querySelector(".game-of-the-week-description")!
      .textContent!.trim();
  }

  it("shows an ampersand once and no tags, however it was stored", async () => {
    const stored = sanitizeHtml("<p>Sam & Max hit the road.</p><p>Classic.</p>");

    expect(widgetText(await renderWidget(stored))).toBe(
      "Sam & Max hit the road. Classic.",
    );
  });

  it.each([
    ["a<br>b", "a b"],
    ["a<br />b", "a b"],
  ])("flattens %j to %j", async (stored, expected) => {
    expect(widgetText(await renderWidget(stored))).toBe(expected);
  });

  it("renders an empty blurb rather than 'undefined' for a game with none", async () => {
    expect(widgetText(await renderWidget(""))).toBe("");
  });
});

describe("most-played.ejs blurb", () => {
  /** As Game.findMostPlayed hands one over: a Game with the count attached. */
  function playedGame(description: string) {
    return Object.assign(game(description), { playCount: 1234 });
  }

  function renderList(description: string) {
    return ejs.renderFile(
      path.join(VIEWS, "lists/most-played.ejs"),
      {
        title: "100 Most Played Classic MS-DOS Games",
        description: "The hundred most played games.",
        canonicalUrl: "https://oldschoolgames.eu/most-played",
        siteUrl: "https://oldschoolgames.eu",
        asset: (urlPath: string) => urlPath,
        // The real helpers and the real constants rather than stubs: head.ejs
        // and views/og-image.ejs reach for these the same way they reach for
        // `asset` and `siteUrl`, and app.ts is what puts all of them within
        // reach of a template. Imported rather than written out, so a value
        // that changes in utils/site.ts cannot be asserted here in its old
        // spelling.
        buildBreadcrumbs,
        isNoindex,
        genreLabel,
        genreInSentence,
        absoluteUrl,
        breadcrumbLdJson,
        siteName: SITE_NAME,
        siteImage: SITE_IMAGE,
        siteImageWidth: SITE_IMAGE_WIDTH,
        siteImageHeight: SITE_IMAGE_HEIGHT,
        organizationNode,
        games: [playedGame(description)],
        csrfToken: "t",
        // The whole page renders, chrome included, so this carries what the
        // navbar, head and sidebars read off the request. searchQuery is the
        // one app.ts puts on res.locals for the navbar's search box.
        req: {
          query: {},
          params: {},
          path: "/most-played",
          originalUrl: "/most-played",
          session: {},
          flash: () => ({}),
        },
        searchQuery: "",
      },
      { root: VIEWS, views: [VIEWS] },
    );
  }

  function cardText(html: string): string {
    const { document } = new JSDOM(html).window;

    return document
      .querySelector(".game-item .clearfix > div")!
      .textContent!.trim();
  }

  it("shows an ampersand once and no tags, however it was stored", async () => {
    const stored = sanitizeHtml("<p>Sam & Max hit the road.</p><p>Classic.</p>");

    expect(cardText(await renderList(stored))).toBe(
      "Sam & Max hit the road. Classic.",
    );
  });

  // The old markup appended "..." to every row, truncated or not, and cut at
  // 250 characters wherever that happened to fall.
  it("adds no ellipsis to a description that fits", async () => {
    expect(cardText(await renderList("Short and sweet."))).toBe(
      "Short and sweet.",
    );
  });

  it("cuts a long description on a word boundary and marks it", async () => {
    const shown = cardText(await renderList(`${"word ".repeat(200)}end`));

    expect(shown.endsWith("…")).toBe(true);
    expect(shown).not.toContain("wor…");
  });
});

describe("Game#summary", () => {
  it("is what the /collection JSON serves for the same card", async () => {
    const stored = sanitizeHtml("<p>Sam & Max</p><br>hit the road");

    expect(game(stored).summary).toBe("Sam & Max hit the road");
  });

  it("survives a description the column allows to be null", () => {
    expect(game(null as any).summary).toBe("");
  });
});
