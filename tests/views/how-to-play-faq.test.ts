import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import { HOW_TO_PLAY_FAQ, faqLdJson } from "../../utils/faq.ts";
import {
  breadcrumbLdJson,
  buildBreadcrumbs,
} from "../../utils/breadcrumbs.ts";
import { isNoindex } from "../../utils/indexability.ts";
import { genreInSentence, genreLabel } from "../../utils/genre-label.ts";
import { absoluteUrl } from "../../utils/site.ts";
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
 * The FAQ on /how-to-play, rendered for real.
 *
 * The point of this file is the last test: the questions Google is told the
 * page answers have to be the questions the page visibly answers. That is not
 * a style preference — structured data describing something the reader cannot
 * find is what a manual action for spammy structured data is for, and it is
 * the exact failure utils/breadcrumbs.ts was written to close, where a
 * hand-built BreadcrumbList had drifted from the trail the page drew.
 *
 * utils/faq.ts makes the drift impossible by construction — one array feeds
 * both — so this is here to keep it impossible: the day somebody writes a
 * question straight into the template, or builds the schema from a second
 * list, this fails.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

/** The page as a visitor receives it, locals and all. */
function renderPage(): Promise<string> {
  return ejs.renderFile(
    path.join(VIEWS, "how-to-play.ejs"),
    {
      title: "How to Play MS-DOS Games - OldSchoolGames.eu",
      description: "How to play, save and control classic DOS games.",
      canonicalUrl: `${SITE_URL}/how-to-play`,
      faq: HOW_TO_PLAY_FAQ,
      faqLdJson: faqLdJson(HOW_TO_PLAY_FAQ),
      // What app.ts puts on app.locals, and what the middleware fills in.
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
      genreLabel,
      genreInSentence,
      absoluteUrl,
      breadcrumbLdJson,
      organizationNode,
      organizationRef: ORGANIZATION_REF,
      csrfToken: "t",
      cspNonce: "n",
      req: {
        path: "/how-to-play",
        originalUrl: "/how-to-play",
        query: {},
        params: {},
        session: {},
      },
      searchQuery: "",
      sidebarGenres: ["ACTION", "ADVENTURE"],
      recentComments: [],
      discussedGames: [],
      topRatedGames: [],
      favoriteGames: [],
    },
    { root: VIEWS, views: [VIEWS] },
  );
}

/** The one FAQPage node in the page's <head>, parsed. */
function faqNode(document: Document): Record<string, any> {
  const blocks = [
    ...document.querySelectorAll('script[type="application/ld+json"]'),
  ].map((script) => JSON.parse(script.textContent ?? "{}"));

  const faq = blocks.filter((node) => node["@type"] === "FAQPage");

  expect(faq).toHaveLength(1);

  return faq[0];
}

describe("/how-to-play FAQ", () => {
  it("has questions to describe", async () => {
    // A floor, not the number, so adding a question does not fail this.
    expect(HOW_TO_PLAY_FAQ.length).toBeGreaterThanOrEqual(5);

    for (const entry of HOW_TO_PLAY_FAQ) {
      expect(entry.question.trim()).not.toBe("");
      expect(entry.answer.trim()).not.toBe("");
    }
  });

  it("ships a valid FAQPage node", async () => {
    const { document } = new JSDOM(await renderPage()).window;
    const node = faqNode(document);

    expect(node["@context"]).toBe("https://schema.org");
    expect(node.mainEntity).toHaveLength(HOW_TO_PLAY_FAQ.length);

    for (const question of node.mainEntity) {
      expect(question["@type"]).toBe("Question");
      expect(question.acceptedAnswer["@type"]).toBe("Answer");
    }
  });

  it("says nothing the reader cannot also see", async () => {
    const { document } = new JSDOM(await renderPage()).window;
    const node = faqNode(document);

    // textContent, not the HTML: an answer the template escaped into entities
    // still reads as the original sentence here, which is what a visitor sees
    // and so what the schema has to match.
    const visible = document.body.textContent ?? "";

    for (const question of node.mainEntity) {
      expect(visible).toContain(question.name);
      expect(visible).toContain(question.acceptedAnswer.text);
    }
  });
});
