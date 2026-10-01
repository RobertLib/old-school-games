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
 * views/400.ejs as the refusal page it is for every comment posted without
 * JavaScript and turned away — not only for a 400.
 *
 * routes/comments.ts renders it with the status it answered: 404 for a game
 * that has gone, 409 for a reply to a removed comment, 429 from the limiter.
 * Every one of them used to be headed "400 — Bad request", and a message that
 * ended in a full stop was given a second one: "…please try again later..
 * Go back and try again."
 *
 * Rendered for real, because the heading and the sentence are what the page
 * makes of its locals.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

async function render(locals: Record<string, unknown>): Promise<Document> {
  const html = await ejs.renderFile(
    path.join(VIEWS, "400.ejs"),
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
      noindex: true,
      req: {
        path: "/comments",
        originalUrl: "/comments",
        query: {},
        params: {},
        session: {},
      },
      ...locals,
    },
    { root: VIEWS, views: [VIEWS] },
  );

  return new JSDOM(html).window.document;
}

function heading(document: Document): string {
  return document.querySelector("main h1")?.textContent?.trim() ?? "";
}

function reason(document: Document): string {
  return document.querySelector("main p")?.textContent?.trim() ?? "";
}

describe("the refusal page", () => {
  it("is a 400 when nobody says otherwise", async () => {
    const document = await render({ message: "Content is required" });

    expect(heading(document)).toBe("400 — Bad request");
    expect(document.title).toBe("400 - Bad Request - OldSchoolGames");
    expect(reason(document)).toBe(
      "Content is required. Go back and try again.",
    );
  });

  it.each([
    [404, "404 — Not found", "404 - Not Found - OldSchoolGames"],
    [409, "409 — Conflict", "409 - Conflict - OldSchoolGames"],
    [429, "429 — Too many requests", "429 - Too Many Requests - OldSchoolGames"],
  ])("is headed with the %s it was answered with", async (status, h1, title) => {
    const document = await render({ status, message: "Game not found" });

    expect(heading(document)).toBe(h1);
    expect(document.title).toBe(title);
  });

  // A status nobody renders this page with is not printed as if it were one.
  it("falls back to 400 for a status it has no heading for", async () => {
    const document = await render({ status: 418, message: "x" });

    expect(heading(document)).toBe("400 — Bad request");
  });

  it("ends a message that has its own full stop with one, not two", async () => {
    const document = await render({
      status: 429,
      message: "Too many comments, please try again later.",
    });

    expect(reason(document)).toBe("Too many comments, please try again later.");
  });

  it("does not tell a reader twice to try again", async () => {
    const document = await render({
      status: 409,
      message: "That comment was removed — please reload and try again",
    });

    expect(reason(document)).toBe(
      "That comment was removed — please reload and try again.",
    );
  });

  it("keeps its own sentence when there is no message", async () => {
    const document = await render({});

    expect(heading(document)).toBe("400 — Bad request");
    expect(reason(document)).toContain("That request could not be processed");
  });
});
