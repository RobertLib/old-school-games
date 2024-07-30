import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import Game from "../../models/game.ts";
import { LISTS } from "../../routes/lists.ts";
import {
  HOME_CRUMB,
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
import {
  ORGANIZATION_REF,
  organizationNode,
} from "../../utils/organization.ts";

/**
 * A curated list page, rendered for real.
 *
 * Nothing ever ran this template: the route suite mocks res.render and asserts
 * locals, which is how views/games/game-filters.ejs sat on this page for as
 * long as it did doing nothing at all — writing "?orderBy=…" controls that the
 * route never read, under a heading that called a genre list "Games of all
 * genres". A template only a mock has seen is a template nobody has seen.
 *
 * The list is one capped page now (see LIST_SIZE in routes/lists.ts), so what
 * is checked here is that it renders without the pagination locals it used to
 * be handed, and that neither the sort bar nor the pager came back.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

const list = LISTS.find((entry) => entry.slug === "best-rpg-games")!;

function game(id: number, title: string) {
  return new Game({
    id,
    title,
    slug: title.toLowerCase().replace(/\s+/g, "-"),
    description: "A game.",
    genre: "RPG",
    release: 1992,
    developer: "Origin Systems",
    publisher: "Origin Systems",
    images: [],
    stream: "",
    manual: "",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  } as any);
}

const games = [
  game(1, "Ultima Underworld"),
  game(2, "Betrayal at Krondor"),
  game(3, "Darklands"),
];

/** The page as a visitor receives it — exactly the locals the route passes. */
function renderPage(): Promise<string> {
  return ejs.renderFile(
    path.join(VIEWS, "lists/list.ejs"),
    {
      breadcrumbs: [
        { ...HOME_CRUMB },
        { name: "Game Lists", path: "/game-lists" },
        { name: list.h1 },
      ],
      list,
      games,
      relatedLists: LISTS.filter((entry) =>
        list.relatedSlugs.includes(entry.slug),
      ),
      title: list.title,
      description: list.description,
      canonicalUrl: `${SITE_URL}/${list.slug}`,
      // What app.ts puts on app.locals, and what the middleware fills in.
      asset: (file: string) => file,
      siteUrl: SITE_URL,
      siteTitle: SITE_TITLE,
      siteDescription: SITE_DESCRIPTION,
      siteName: SITE_NAME,
      siteImage: SITE_IMAGE,
      siteImageWidth: SITE_IMAGE_WIDTH,
      siteImageHeight: SITE_IMAGE_HEIGHT,
      mediaOrigin: "https://media.example.com",
      buildBreadcrumbs,
      isNoindex,
      breadcrumbLdJson,
      organizationNode,
      organizationRef: ORGANIZATION_REF,
      csrfToken: "t",
      cspNonce: "n",
      req: {
        path: `/${list.slug}`,
        originalUrl: `/${list.slug}`,
        query: {},
        params: {},
        session: {},
      },
      searchQuery: "",
      sidebarGenres: ["ACTION", "RPG"],
      recentComments: [],
      discussedGames: [],
      topRatedGames: [],
      favoriteGames: [],
    },
    { root: VIEWS, views: [VIEWS] },
  );
}

describe("a curated list page", () => {
  it("renders without the pagination locals it used to be handed", async () => {
    const { document } = new JSDOM(await renderPage()).window;

    expect(document.querySelector("h1")?.textContent?.trim()).toBe(list.h1);
    expect(document.querySelectorAll("ol.game-list li")).toHaveLength(
      games.length,
    );
  });

  it("numbers the entries, because the order is the claim it makes", async () => {
    const { document } = new JSDOM(await renderPage()).window;
    const ranks = [...document.querySelectorAll("ol.game-list > li")].map(
      (li) => li.firstElementChild?.textContent?.trim(),
    );

    expect(ranks).toEqual(["#1", "#2", "#3"]);
  });

  /**
   * The sort controls did nothing here — the route orders by list.findParams
   * and never looked at req.query — and every one of them minted another
   * noindex address for a crawler to spend its budget on.
   */
  it("shows no sort bar", async () => {
    const { document } = new JSDOM(await renderPage()).window;

    expect(document.querySelector(".game-filters")).toBeNull();
    expect(document.querySelector(".sorting-options")).toBeNull();
  });

  it("shows no pagination", async () => {
    const html = await renderPage();
    const { document } = new JSDOM(html).window;

    expect(document.querySelector("nav.pagination")).toBeNull();
    expect(html).not.toContain("?page=");
  });

  it("declares itself canonical at its own address", async () => {
    const { document } = new JSDOM(await renderPage()).window;

    expect(
      document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    ).toBe(`${SITE_URL}/${list.slug}`);
    expect(document.querySelector('link[rel="next"]')).toBeNull();
    expect(document.querySelector('link[rel="prev"]')).toBeNull();
  });

  /** ItemList has to describe what is on the page, not what the filter matched. */
  it("counts the games it actually shows", async () => {
    const { document } = new JSDOM(await renderPage()).window;

    const node = [
      ...document.querySelectorAll('script[type="application/ld+json"]'),
    ]
      .map((script) => JSON.parse(script.textContent ?? "{}"))
      .find((parsed) => parsed["@type"] === "ItemList");

    expect(node).toBeDefined();
    expect(node.numberOfItems).toBe(games.length);
    expect(node.itemListElement.map((item: any) => item.position)).toEqual([
      1, 2, 3,
    ]);
    expect(node.itemListElement[0].item.name).toBe("Ultima Underworld");
  });
});
