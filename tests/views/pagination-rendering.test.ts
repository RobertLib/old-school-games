import { describe, expect, it } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";

/**
 * The pager, rendered for real.
 *
 * Every link on it is built by one helper in the template, and the two
 * things that helper got wrong were only visible in the HTML: the "first
 * page" button pointed at "?page=1" — a second crawlable address for a page
 * whose canonical link names the bare URL — and a repeated query parameter
 * was collapsed into one comma-joined value that no route parses back.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(__dirname, "../../views/pagination.ejs");

async function render(options: {
  page: number;
  total: number;
  limit?: number;
  query?: Record<string, string | string[]>;
  originalUrl: string;
}): Promise<string> {
  const limit = options.limit ?? 10;

  return ejs.renderFile(TEMPLATE, {
    page: options.page,
    limit,
    total: options.total,
    // What a route hands the pager: only the current page's rows.
    games: Array.from(
      { length: Math.max(0, Math.min(limit, options.total - (options.page - 1) * limit)) },
      (_, i) => ({ id: i }),
    ),
    req: { originalUrl: options.originalUrl, query: options.query ?? {} },
  });
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!);
}

describe("views/pagination.ejs", () => {
  /**
   * "?page=1" and the bare address are one page under two URLs, which is the
   * duplicate-content trap parsePageParam refuses "?page=01" for and which
   * paginationUrls already avoided in the <head>. The "<<" button was the one
   * link left pointing at the other one.
   */
  it("links the first page at the bare address", async () => {
    const html = await render({ page: 3, total: 100, originalUrl: "/action" });

    expect(hrefs(html)).toContain("/action");
    expect(html).not.toContain("page=1\"");
  });

  it("keeps the first page bare while preserving the other parameters", async () => {
    const html = await render({
      page: 3,
      total: 100,
      originalUrl: "/search?q=doom&page=3",
      query: { q: "doom", page: "3" },
    });

    expect(hrefs(html)).toContain("/search?q=doom");
  });

  /**
   * A repeated key is an array in req.query, and handing the object to
   * URLSearchParams stringifies that array by joining it with commas — so
   * "?genre=rpg&genre=action" came out of the pager as one parameter reading
   * "rpg,action".
   */
  it("preserves a repeated query key rather than joining it with commas", async () => {
    const html = await render({
      page: 1,
      total: 100,
      originalUrl: "/games?genre=rpg&genre=action",
      query: { genre: ["rpg", "action"] },
    });

    const next = hrefs(html).find((href) => href.includes("page=2"))!;

    // "&amp;" because EJS escapes the attribute, which is what an href in
    // HTML is supposed to look like; a browser reads it as "&".
    expect(next).toBe("/games?genre=rpg&amp;genre=action&amp;page=2");
    expect(next).not.toContain("rpg,action");
  });

  // The path comes off originalUrl, not req.path, which express rewrites to
  // be relative to whichever router is dispatching by the time a view runs.
  it("builds its links against the address the request arrived at", async () => {
    const html = await render({ page: 2, total: 100, originalUrl: "/news?page=2" });

    for (const href of hrefs(html)) {
      expect(href.startsWith("/news")).toBe(true);
    }
  });
});

/**
 * The same pager, rendered for the two pages that used to carry a copy of it.
 *
 * views/comments/comments-index.ejs and views/news/news-list.ejs each had
 * their own window, their own summary and their own buttons — and both copies
 * had drifted: each wrote "?page=1" for page 1, the second crawlable address
 * for a page whose canonical link names the bare URL, and neither carried
 * rel="prev"/rel="next". So they pass `items` and a noun instead.
 */
describe("views/pagination.ejs — reused by the comment and news lists", () => {
  function renderItems(options: {
    itemNoun: string;
    page: number;
    total: number;
    limit: number;
    originalUrl: string;
  }): Promise<string> {
    const shown = Math.max(
      0,
      Math.min(options.limit, options.total - (options.page - 1) * options.limit),
    );

    return ejs.renderFile(TEMPLATE, {
      page: options.page,
      limit: options.limit,
      total: options.total,
      itemNoun: options.itemNoun,
      items: Array.from({ length: shown }, (_, i) => ({ id: i })),
      req: { originalUrl: options.originalUrl, query: {} },
    });
  }

  it("counts in whatever the page is a list of", async () => {
    const html = await renderItems({
      itemNoun: "comment",
      page: 1,
      total: 42,
      limit: 20,
      originalUrl: "/comments",
    });

    expect(html).toContain("comments");
    expect(html).not.toContain("games");
  });

  it("pluralises a two-word noun as well", async () => {
    const html = await renderItems({
      itemNoun: "news item",
      page: 1,
      total: 3,
      limit: 10,
      originalUrl: "/news",
    });

    expect(html).toContain("news items");
  });

  it("still addresses page 1 as the bare URL", async () => {
    const html = await renderItems({
      itemNoun: "comment",
      page: 3,
      total: 100,
      limit: 20,
      originalUrl: "/comments?page=3",
    });

    expect(hrefs(html)).toContain("/comments");
    expect(html).not.toContain('page=1"');
  });

  // The half the hand-written copies were missing: these tell a crawler the
  // pages are one sequence rather than a hundred unrelated addresses.
  it("marks the neighbours with rel=prev and rel=next", async () => {
    const html = await renderItems({
      itemNoun: "comment",
      page: 3,
      total: 100,
      limit: 20,
      originalUrl: "/comments?page=3",
    });

    expect(html).toContain('rel="prev"');
    expect(html).toContain('rel="next"');
    expect(html).toContain('aria-current="page"');
  });
});
