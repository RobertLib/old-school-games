import { describe, expect, it } from "vitest";
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
  SITE_TITLE,
  SITE_URL,
  absoluteUrl,
} from "../../utils/site.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

function renderHead(
  query: Record<string, string>,
  locals: Record<string, unknown> = {},
): Promise<string> {
  return ejs.renderFile(
    path.join(VIEWS, "head.ejs"),
    {
      asset: (file: string) => file,
      siteUrl: SITE_URL,
      siteTitle: SITE_TITLE,
      siteDescription: SITE_DESCRIPTION,
      siteImage: SITE_IMAGE,
      buildBreadcrumbs,
      breadcrumbLdJson,
      isNoindex,
      genreLabel,
      genreInSentence,
      absoluteUrl,
      csrfToken: "t",
      cspNonce: "n",
      req: { path: "/", originalUrl: "/", query, params: {} },
      canonicalUrl: `${SITE_URL}/`,
      prevPageUrl: `${SITE_URL}/`,
      nextPageUrl: `${SITE_URL}/?page=3`,
      ...locals,
    },
    { root: VIEWS, views: [VIEWS] },
  );
}

const links = (html: string) => {
  const { document } = new JSDOM(`<head>${html}</head>`).window;

  return {
    prev: document.querySelector('link[rel="prev"]')?.getAttribute("href"),
    next: document.querySelector('link[rel="next"]')?.getAttribute("href"),
  };
};

/**
 * rel=prev/next describe the sequence the canonical belongs to. The routes
 * build them from the unfiltered listing, so on a search or a re-sort they
 * pointed at pages of a different list — "/?search=doom&page=2" called the
 * homepage its previous page. A noindex page now announces no sequence.
 */
describe("the prev/next pair in <head>", () => {
  it("is written on a page that asks to be indexed", async () => {
    const { prev, next } = links(await renderHead({ page: "2" }));

    expect(prev).toBe(`${SITE_URL}/`);
    expect(next).toBe(`${SITE_URL}/?page=3`);
  });

  it.each([
    ["a search", { search: "doom", page: "2" }],
    ["a re-sort", { orderBy: "title", page: "2" }],
  ])("is left off %s", async (_label, query) => {
    const { prev, next } = links(await renderHead(query));

    expect(prev).toBeUndefined();
    expect(next).toBeUndefined();
  });

  it("is left off a page that is noindex on its own account", async () => {
    const { prev } = links(await renderHead({}, { noindex: true }));

    expect(prev).toBeUndefined();
  });
});
