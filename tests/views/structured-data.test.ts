import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import Game from "../../models/game.ts";
import { LISTS } from "../../routes/lists.ts";
import { breadcrumbLdJson, buildBreadcrumbs } from "../../utils/breadcrumbs.ts";
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
 * The JSON-LD a listing page publishes about itself.
 *
 * Three things went wrong here at once and none of them were visible, because
 * structured data is the one part of a page that no visitor ever sees and no
 * test rendered: the route suite mocks res.render and asserts locals, which
 * cannot reach a node the template builds on its own.
 *
 *   - Every page of a listing claimed to hold positions 1 to 10 of its list.
 *     The offset that views/news/news-list.ejs has always applied was missing
 *     everywhere else, so /shooter?page=7 announced itself as the top of the
 *     shooter ranking, and so did every other page of every other filter —
 *     several hundred addresses in the sitemap all making the same claim.
 *   - A curated list stated numberOfItems: 100 beside ten described items.
 *   - A search result — noindex, and canonicalised away — still shipped a full
 *     description of itself to a consumer that had just been told to skip it.
 *
 * All three are assertions about a <script> tag's contents, which is why they
 * are made here rather than left to the route tests.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

function game(id: number, title: string) {
  return new Game({
    id,
    title,
    slug: title.toLowerCase().replace(/\s+/g, "-"),
    description: "A game.",
    genre: "SHOOTER",
    release: 1993,
    developer: "id Software",
    publisher: "id Software",
    images: ["https://media.example.com/cover.png"],
    stream: "",
    manual: "",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  } as any);
}

/** What app.ts puts on app.locals, and what the middleware fills in. */
const APP_LOCALS = {
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
  breadcrumbLdJson,
  isNoindex,
  organizationNode,
  organizationRef: ORGANIZATION_REF,
  csrfToken: "t",
  cspNonce: "n",
  searchQuery: "",
  sidebarGenres: ["ACTION", "SHOOTER"],
  recentComments: [],
  discussedGames: [],
  topRatedGames: [],
  favoriteGames: [],
};

/** Every JSON-LD node on the page, parsed. */
function nodes(html: string): Record<string, any>[] {
  const { document } = new JSDOM(html).window;

  return [
    ...document.querySelectorAll('script[type="application/ld+json"]'),
  ].map((tag) => JSON.parse(tag.textContent!));
}

function nodeOfType(
  html: string,
  type: string,
): Record<string, any> | undefined {
  return nodes(html).find((node) => node["@type"] === type);
}

describe("the listing ItemList", () => {
  /** views/index.ejs, as every filter route renders it. */
  function renderListing({
    page = 1,
    total = 120,
    query = {} as Record<string, unknown>,
    count = 25,
  } = {}): Promise<string> {
    const originalUrl = page > 1 ? `/shooter?page=${page}` : "/shooter";

    return ejs.renderFile(
      path.join(VIEWS, "index.ejs"),
      {
        ...APP_LOCALS,
        games: Array.from({ length: count }, (_, i) =>
          game(i + 1, `Game ${i + 1}`),
        ),
        total,
        page,
        limit: 25,
        genre: "SHOOTER",
        search: query.search ?? "",
        suggestions: [],
        recentNews: [],
        featuredGames: [],
        canonicalUrl: `${SITE_URL}${originalUrl}`,
        validYears: [],
        req: {
          path: "/shooter",
          originalUrl,
          query,
          params: {},
          session: {},
        },
      },
      { root: VIEWS, views: [VIEWS] },
    );
  }

  it("numbers a game by its place in the whole listing, not in the page", async () => {
    const list = (await nodeOfType(
      await renderListing({ page: 3 }),
      "WebPage",
    ))!.mainEntity;

    // Page 3 of a 25-a-page listing starts at 51, not at 1.
    expect(list.itemListElement[0].position).toBe(51);
    expect(list.itemListElement.at(-1).position).toBe(75);
  });

  it("starts at 1 on the first page", async () => {
    const list = nodeOfType(await renderListing(), "WebPage")!.mainEntity;

    expect(list.itemListElement[0].position).toBe(1);
  });

  it("describes every game the page renders", async () => {
    const list = nodeOfType(await renderListing(), "WebPage")!.mainEntity;

    expect(list.itemListElement).toHaveLength(25);
  });

  it("counts the whole listing, not the page", async () => {
    const list = nodeOfType(await renderListing(), "WebPage")!.mainEntity;

    expect(list.numberOfItems).toBe(120);
  });

  it("says nothing at all on a page that asks not to be indexed", async () => {
    const html = await renderListing({ query: { search: "doom" } });

    // The robots tag and the absent canonical are head.ejs's half of this;
    // what matters here is that the page does not then describe itself anyway.
    expect(html).toContain('name="robots"');
    expect(nodeOfType(html, "WebPage")).toBeUndefined();
  });

  it("still describes a sorted page's *unsorted* twin", async () => {
    // A sort is noindex too — same helper, same answer.
    const html = await renderListing({ query: { orderBy: "title" } });

    expect(nodeOfType(html, "WebPage")).toBeUndefined();
  });
});

describe("a curated list's ItemList", () => {
  const list = LISTS.find((entry) => entry.slug === "best-shooter-games")!;
  const games = Array.from({ length: 40 }, (_, i) =>
    game(i + 1, `Game ${i + 1}`),
  );

  function renderList(): Promise<string> {
    return ejs.renderFile(
      path.join(VIEWS, "lists/list.ejs"),
      {
        ...APP_LOCALS,
        list,
        games,
        relatedLists: [],
        title: list.title,
        description: list.description,
        canonicalUrl: `${SITE_URL}/${list.slug}`,
        req: {
          path: `/${list.slug}`,
          originalUrl: `/${list.slug}`,
          query: {},
          params: {},
          session: {},
        },
      },
      { root: VIEWS, views: [VIEWS] },
    );
  }

  it("describes as many items as it claims to hold", async () => {
    const node = nodeOfType(await renderList(), "ItemList")!;

    expect(node.numberOfItems).toBe(games.length);
    expect(node.itemListElement).toHaveLength(games.length);
  });

  it("numbers them from one, because the list is a single page", async () => {
    const node = nodeOfType(await renderList(), "ItemList")!;

    expect(node.itemListElement[0].position).toBe(1);
    expect(node.itemListElement.at(-1).position).toBe(games.length);
  });
});
