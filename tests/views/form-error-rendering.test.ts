import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import { validateGame, type ValidationError } from "../../validations/games.ts";
import {
  HOME_CRUMB,
  breadcrumbLdJson,
  buildBreadcrumbs,
} from "../../utils/breadcrumbs.ts";
import { isNoindex } from "../../utils/indexability.ts";
import { genreInSentence, genreLabel } from "../../utils/genre-label.ts";
import { absoluteUrl } from "../../utils/site.ts";
import {
  ORGANIZATION_REF,
  organizationNode,
} from "../../utils/organization.ts";

/**
 * The three admin forms, rendered with the errors their validators emit.
 *
 * Nothing ran these templates. The route tests mock res.render and assert the
 * locals, so "errors: [...] reached the view" was the whole of the coverage —
 * and a view that is handed an error it has no markup for looks identical from
 * there. Two fields on the game form were in exactly that state:
 * validations/games.ts refuses a description past DESCRIPTION_MAX_LENGTH and a
 * stream that is not http(s) or a path on this site, and the form drew neither
 * the red border nor the message. The admin got the banner at the top saying
 * to correct the fields marked below, with nothing marked below.
 *
 * The second half of this file is about who the marking is for. A red border
 * and an adjacent <span> are markup a sighted visitor reads; a screen reader
 * was given an ordinary, valid-sounding field, because nothing tied the
 * message to the control. So every message carries id="<field>-error" and
 * every control that has one points at it with aria-describedby and says
 * aria-invalid="true".
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");
const ROOT = path.resolve(__dirname, "../..");

/**
 * What app.ts puts on app.locals and what the sidebar middleware fills in.
 *
 * The news forms are whole pages — head, navbar, both sidebars, flash and
 * footer — so rendering one for real means handing it everything those
 * partials read. game-form.ejs is a partial and needs none of it.
 */
const PAGE_LOCALS = {
  asset: (file: string) => file,
  siteUrl: "https://example.com",
  siteTitle: "Site title",
  siteDescription: "Site description",
  siteName: "Site",
  siteImage: "/images/site.png",
  siteImageWidth: 1200,
  siteImageHeight: 630,
  mediaOrigin: "https://media.example.com",
  title: "Admin form",
  description: "Admin form",
  canonicalUrl: "https://example.com/news",
  breadcrumbs: [{ ...HOME_CRUMB }],
  buildBreadcrumbs,
  breadcrumbLdJson,
  isNoindex,
  genreLabel,
  genreInSentence,
  absoluteUrl,
  organizationNode,
  organizationRef: ORGANIZATION_REF,
  csrfToken: "t",
  cspNonce: "n",
  req: {
    path: "/news/new",
    originalUrl: "/news/new",
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
};

function render(
  view: string,
  locals: Record<string, unknown>,
): Promise<string> {
  return ejs.renderFile(path.join(VIEWS, view), locals, {
    root: VIEWS,
    views: [VIEWS],
  });
}

function renderGameForm(errors: ValidationError[]): Promise<string> {
  return render("games/game-form.ejs", {
    // The new-game route passes null rather than leaving it out: EJS compiles
    // with `with(locals)`, so a name that is absent altogether throws.
    game: null,
    gameGenres: ["ACTION", "RPG"],
    csrfToken: "t",
    errors,
    formData: {},
  });
}

const newsItem = {
  id: 1,
  slug: "a-news-item",
  title: "A news item",
  content: "Some content",
};

function renderNewsForm(
  view: "news/new-news.ejs" | "news/edit-news.ejs",
  errors: ValidationError[],
): Promise<string> {
  return render(view, { ...PAGE_LOCALS, newsItem, errors });
}

const dom = (html: string) => new JSDOM(html).window.document;

describe("the game form shows every error it can be handed", () => {
  /**
   * Both of these used to fall through: the field had no `invalid()` on its
   * class and no <span> under it, so the message was rendered nowhere at all.
   */
  it.each([
    ["description", "Description cannot be longer than 10000 characters"],
    ["stream", "Stream must be an http(s) address or a path on this site"],
  ])("marks %s and prints its message", async (field, message) => {
    const document = dom(await renderGameForm([{ field, message }]));
    const control = document.getElementById(field)!;

    expect(control).not.toBeNull();
    expect(control.className).toContain("is-invalid");
    expect(document.getElementById(`${field}-error`)?.textContent?.trim()).toBe(
      message,
    );
  });

  it("marks nothing on a form that was not refused", async () => {
    const document = dom(await renderGameForm([]));

    expect(document.querySelectorAll(".invalid-feedback")).toHaveLength(0);
    expect(document.querySelectorAll(".is-invalid")).toHaveLength(0);
    // aria-invalid="false" everywhere would be a claim about each field rather
    // than the absence of one, which is why it is written only with an error.
    expect(document.querySelectorAll("[aria-invalid]")).toHaveLength(0);
    expect(document.querySelectorAll("[aria-describedby]")).toHaveLength(0);
  });
});

/**
 * Every field name validateGame can put in an error, against the form that is
 * supposed to show it.
 *
 * Read off the validator rather than written down here, because a list written
 * down here agrees with validations/games.ts on the day it is written and
 * never again — which is the exact way "description" and "stream" came to be
 * refused by a form that could not say so. Collected two ways, because neither
 * alone is complete: driving the function catches the two fields it pushes
 * under a shorthand `{ field, message }` inside a loop (developer, publisher),
 * and reading the source catches any field whose message exists but that no
 * payload below happens to trigger.
 */
describe("every field validateGame can refuse", () => {
  const GENRES = ["ACTION", "RPG"];

  /** Payloads chosen to make the validator emit as much as it can at once. */
  const PAYLOADS: Record<string, unknown>[] = [
    {
      title: "",
      // One character past DESCRIPTION_MAX_LENGTH, which is 10000.
      description: "x".repeat(10_001),
      genre: "",
      release: "not-a-year",
      developer: "d".repeat(256),
      publisher: "p".repeat(256),
      images: ["javascript:alert(1)"],
      manual: "javascript:alert(1)",
      stream: "javascript:alert(1)",
    },
    // The other way "images" is refused, and the out-of-range year, neither of
    // which the payload above reaches.
    { images: [{ not: "a string" }], release: "1492" },
    { title: "t".repeat(256), genre: "NOT_A_GENRE" },
  ];

  const fields = new Set<string>();

  for (const payload of PAYLOADS) {
    for (const error of validateGame({ ...payload }, GENRES)) {
      fields.add(error.field);
    }
  }

  // Plus anything the source names that nothing above triggered.
  for (const match of readFileSync(
    path.join(ROOT, "validations/games.ts"),
    "utf-8",
  ).matchAll(/\bfield:\s*"([^"]+)"/g)) {
    fields.add(match[1]!);
  }

  const names = [...fields].sort();

  /**
   * A floor, so that a payload which quietly stops triggering anything cannot
   * turn this whole block into zero cases — the trap every it.each over a
   * derived list has.
   */
  it("collected the fields it is about", () => {
    expect(names.length).toBeGreaterThanOrEqual(9);
    expect(names).toContain("description");
    expect(names).toContain("stream");
  });

  it.each(names)("%s has somewhere to appear on the form", async (field) => {
    const message = `Refused: ${field}`;
    const document = dom(await renderGameForm([{ field, message }]));
    const site = document.getElementById(`${field}-error`);

    expect(site, `no #${field}-error in views/games/game-form.ejs`).not.toBeNull();
    expect(site!.textContent!.trim()).toBe(message);
    expect(site!.className).toContain("invalid-feedback");
  });

  it.each(names)("%s names a control that points back at it", async (field) => {
    const document = dom(await renderGameForm([{ field, message: "Refused" }]));
    const described = [
      ...document.querySelectorAll(`[aria-describedby="${field}-error"]`),
    ];

    // "images" is four inputs sharing one message, so this is "at least one"
    // rather than "exactly one".
    expect(described.length).toBeGreaterThan(0);

    for (const control of described) {
      expect(control.getAttribute("aria-invalid")).toBe("true");
      expect(control.className).toContain("is-invalid");
    }
  });
});

/**
 * The same wiring on the two news forms, which had it in neither place.
 * Consistency across the three matters more than it looks: an admin meets them
 * as one interface, and a message that is announced on one form and silent on
 * the next is worse than one that is silent on both.
 */
describe("the news forms wire their messages to their controls", () => {
  const views = ["news/new-news.ejs", "news/edit-news.ejs"] as const;

  for (const view of views) {
    describe(view, () => {
      it.each(["title", "content"])(
        "ties the %s message to the field",
        async (field) => {
          const message = `Refused: ${field}`;
          const document = dom(await renderNewsForm(view, [{ field, message }]));
          const control = document.getElementById(field)!;

          expect(control).not.toBeNull();
          expect(control.className).toContain("is-invalid");
          expect(control.getAttribute("aria-invalid")).toBe("true");
          expect(control.getAttribute("aria-describedby")).toBe(
            `${field}-error`,
          );
          expect(
            document.getElementById(`${field}-error`)?.textContent?.trim(),
          ).toBe(message);
        },
      );

      it("says nothing about a field it was not handed an error for", async () => {
        const document = dom(
          await renderNewsForm(view, [{ field: "title", message: "Refused" }]),
        );

        expect(document.getElementById("content")!.hasAttribute("aria-invalid")).toBe(
          false,
        );
        expect(document.getElementById("content-error")).toBeNull();
      });
    });
  }
});

/**
 * An aria-describedby that names an id which is not in the document is
 * ignored by every screen reader, silently — the failure that looks exactly
 * like the fix. So the reference and the target are checked as a pair, on all
 * three forms at once.
 */
describe("no form points at a message that is not there", () => {
  it("resolves every aria-describedby it writes", async () => {
    const htmls = await Promise.all([
      renderGameForm([
        { field: "title", message: "a" },
        { field: "description", message: "b" },
        { field: "genre", message: "c" },
        { field: "release", message: "d" },
        { field: "developer", message: "e" },
        { field: "publisher", message: "f" },
        { field: "images", message: "g" },
        { field: "stream", message: "h" },
        { field: "manual", message: "i" },
      ]),
      renderNewsForm("news/new-news.ejs", [
        { field: "title", message: "a" },
        { field: "content", message: "b" },
      ]),
      renderNewsForm("news/edit-news.ejs", [
        { field: "title", message: "a" },
        { field: "content", message: "b" },
      ]),
    ]);

    for (const html of htmls) {
      const document = dom(html);
      const dangling = [...document.querySelectorAll("[aria-describedby]")]
        .flatMap((control) =>
          control.getAttribute("aria-describedby")!.split(/\s+/),
        )
        .filter((id) => document.getElementById(id) === null);

      expect(dangling).toEqual([]);
    }
  });
});

/**
 * validateGame accepts a cover, a screenshot or a manual given as a path on
 * this site. The form's own inputs used to be type="url", which accepts only
 * an absolute address — so a game whose cover was stored as a path failed the
 * browser's check and its edit form could not be submitted at all.
 */
describe("the game form accepts what the validator accepts", () => {
  it("lets a path on this site through the browser's own check", async () => {
    const html = await render("games/game-form.ejs", {
      game: {
        id: 1,
        title: "Doom",
        genre: "ACTION",
        images: ["/images/doom.png", "", "", ""],
        manual: "/manuals/doom.pdf",
      },
      gameGenres: ["ACTION", "RPG"],
      csrfToken: "t",
      errors: [],
      formData: {},
    });
    const document = dom(html);

    for (const id of ["image-cover", "image-1", "image-2", "image-3", "manual"]) {
      const input = document.getElementById(id) as HTMLInputElement;

      expect(input.type).toBe("text");
      // The phone keyboard a URL wants, without the check a path fails.
      expect(input.getAttribute("inputmode")).toBe("url");
      expect(input.checkValidity()).toBe(true);
    }
  });
});
