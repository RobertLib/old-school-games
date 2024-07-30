import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import type { Request, Response } from "express";
import { validateComment } from "../../validations/comments.ts";
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
  absoluteUrl,
} from "../../utils/site.ts";

/**
 * Every other route test mocks res.render and asserts the view name and its
 * locals, which is why nothing caught a comment being escaped twice: the
 * templates were never actually run. These render for real and read the
 * result the way a browser would.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../../views");

function renderComment(
  overrides: Record<string, unknown> = {},
  locals: Record<string, unknown> = {},
) {
  const comment = {
    id: 1,
    nick: "player",
    content: "Hello",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    parentId: null,
    replies: [],
    ...overrides,
  };

  return ejs.renderFile(
    path.join(VIEWS, "comments/comment-item.ejs"),
    { comment, isReply: false, csrfToken: "t", ...locals },
    { root: VIEWS, views: [VIEWS] },
  );
}

/** What the reader actually sees, entities resolved once, as a browser does. */
function visibleText(html: string, selector: string): string {
  const { document } = new JSDOM(html).window;

  return document.querySelector(selector)!.textContent!.trim();
}

describe("comment-item.ejs", () => {
  // The bug this guards: the validator sanitized the text on the way in,
  // turning "<" into "&lt;", and the template escaped it again on the way
  // out. The browser received "&amp;lt;3" and showed the reader "&lt;3".
  it.each([
    ["<3 this game", "<3 this game"],
    ["Speedrun in 5 < 10 minutes", "Speedrun in 5 < 10 minutes"],
    ["Sam & Max rules", "Sam & Max rules"],
    ["a < b > c", "a < b > c"],
    ['He said "hi"', 'He said "hi"'],
    ["it's fine", "it's fine"],
  ])("shows %j to the reader as typed", async (stored, expected) => {
    const html = await renderComment({ content: stored });

    expect(visibleText(html, ".comment-content")).toBe(expected);
  });

  it("shows a nick to the reader as typed", async () => {
    const html = await renderComment({ nick: "<3 player" });

    expect(visibleText(html, ".comment-nick")).toBe("<3 player");
  });

  // Comments are stored exactly as typed, so the escaping in the template is
  // the only thing making them safe to display. If a template ever switched
  // to <%- %> this is what would notice.
  it("neutralises markup in the stored text", async () => {
    const html = await renderComment({
      content: '<img src=x onerror="alert(1)">',
    });

    const { document } = new JSDOM(html).window;

    expect(document.querySelector(".comment-content img")).toBeNull();
    expect(visibleText(html, ".comment-content")).toBe(
      '<img src=x onerror="alert(1)">',
    );
  });

  it("neutralises markup in the nick", async () => {
    const html = await renderComment({ nick: "<script>alert(1)</script>" });

    const { document } = new JSDOM(html).window;

    expect(document.querySelector(".comment-nick script")).toBeNull();
  });

  it("offers no reply button on a reply, so threads stay one level deep", async () => {
    const html = await renderComment({}, { isReply: true });
    const { document } = new JSDOM(html).window;

    expect(document.querySelector(".comment-reply-btn")).toBeNull();
  });

  /**
   * The escaping bug lived in neither half on its own — the validator was
   * defensible and so was the template — but in the two of them together.
   * Testing the halves separately is exactly how it went unnoticed, so these
   * put a comment through the validator and then render what it stored.
   */
  describe("posting and then displaying a comment", () => {
    function post(typed: string) {
      const req = { body: { nick: "player", content: typed, gameId: "1" } };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      validateComment(req as unknown as Request, res as unknown as Response, next);

      expect(next).toHaveBeenCalled();

      return req.body.content;
    }

    it.each([
      "<3 this game",
      "Speedrun in 5 < 10 minutes",
      "Sam & Max rules",
      "a < b > c",
      "use -> the arrow keys",
      'He said "hi"',
    ])("round-trips %j back to the reader unchanged", async (typed) => {
      const html = await renderComment({ content: post(typed) });

      expect(visibleText(html, ".comment-content")).toBe(typed);
    });

    it("round-trips a nick unchanged", async () => {
      const req = {
        body: { nick: "<3 player", content: "Hello", gameId: "1" },
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      validateComment(
        req as unknown as Request,
        res as unknown as Response,
        next,
      );

      const html = await renderComment({ nick: req.body.nick });

      expect(visibleText(html, ".comment-nick")).toBe("<3 player");
    });

    /**
     * A Hangul filler is a letter, so a nick made of one used to be stored as
     * it was — and `comment.nick || "anonymous"` counts any stored nick as
     * present, so the h3 over the comment rendered blank. Put through the
     * validator it now comes out as no nick, which the template draws as
     * "anonymous" just as it does an empty field.
     */
    it.each([
      ["a Hangul filler", "\u3164"],
      ["a zero-width space", "\u200b"],
      ["the blank Braille cell", "\u2800"],
    ])("shows a nick that is only %s as anonymous", async (_label, nick) => {
      const req = { body: { nick, content: "Hello", gameId: "1" } };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      validateComment(
        req as unknown as Request,
        res as unknown as Response,
        next,
      );

      expect(next).toHaveBeenCalled();

      const html = await renderComment({ nick: req.body.nick });

      expect(visibleText(html, ".comment-nick")).toBe("anonymous");
    });

    it("still cannot be made to inject script", async () => {
      const stored = post('ok <img src=x onerror="alert(1)">');
      const html = await renderComment({ content: stored });
      const { document } = new JSDOM(html).window;

      expect(document.querySelector(".comment-content img")).toBeNull();
      expect(document.querySelector(".comment-content script")).toBeNull();
    });
  });

  describe("admin controls", () => {
    const asAdmin = { req: { session: { user: { role: "ADMIN" } } } };

    it("asks for confirmation through data-confirm, not an inline handler", async () => {
      const html = await renderComment({}, asAdmin);
      const { document } = new JSDOM(html).window;
      const form = document.querySelector<HTMLFormElement>(
        'form[action="/comments/1/delete"]',
      )!;

      expect(form).not.toBeNull();
      // The Content-Security-Policy sets script-src-attr to 'none', so an
      // on*= attribute here would silently stop working.
      expect(form.getAttribute("onsubmit")).toBeNull();
      expect(form.dataset.confirm).toContain("Delete this comment");
    });

    it("hides the delete form from everyone else", async () => {
      const html = await renderComment();
      const { document } = new JSDOM(html).window;

      expect(document.querySelector("form")).toBeNull();
    });

    /**
     * The way into "delete everything from this source" — a flood used to be
     * one click per comment. It opens the review page rather than deleting
     * anything, so it is a plain form with the CSRF token and no
     * data-confirm; the page it opens is the confirmation.
     */
    it("offers an admin every comment from the same source", async () => {
      const html = await renderComment({ hasSource: true }, asAdmin);
      const { document } = new JSDOM(html).window;
      const form = document.querySelector<HTMLFormElement>(
        'form[action="/comments/1/source"]',
      )!;

      expect(form).not.toBeNull();
      expect(form.method.toLowerCase()).toBe("post");
      expect(
        form.querySelector<HTMLInputElement>('input[name="_csrf"]')!.value,
      ).toBe("t");
      expect(form.textContent).toContain("All from this source");
    });

    // A comment from before sources were recorded, or past the retention
    // window, has nothing to group by; a button would only lead to "none".
    it("does not offer it where no source is recorded", async () => {
      const html = await renderComment({ hasSource: false }, asAdmin);
      const { document } = new JSDOM(html).window;

      expect(
        document.querySelector('form[action="/comments/1/source"]'),
      ).toBeNull();
    });

    it("does not offer it to anyone but an admin", async () => {
      const html = await renderComment({ hasSource: true });
      const { document } = new JSDOM(html).window;

      expect(
        document.querySelector('form[action="/comments/1/source"]'),
      ).toBeNull();
    });
  });
});

/**
 * The review page an admin sees before deleting everything from one source
 * (POST /comments/:id/source in routes/comments.ts). The route test mocks
 * the render, so this is where the page itself is drawn and read.
 */
describe("comment-source.ejs", () => {
  const listed = (id: number, overrides: Record<string, unknown> = {}) => ({
    id,
    nick: `flooder${id}`,
    content: `Buy cheap stuff ${id}`,
    snippet: `Buy cheap stuff ${id}`,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    parentId: null,
    gameId: 1,
    gameTitle: "Doom",
    gameSlug: "doom",
    hasSource: true,
    ...overrides,
  });

  function renderReview(locals: Record<string, unknown> = {}) {
    return ejs.renderFile(
      path.join(VIEWS, "comments/comment-source.ejs"),
      {
        noindex: true,
        title: "Comments from one source - OldSchoolGames",
        breadcrumbs: [
          { name: "Home", path: "/" },
          { name: "Latest Comments", path: "/comments" },
          { name: "Comments from one source" },
        ],
        commentId: 7,
        total: 3,
        otherReplies: 2,
        comments: [listed(9), listed(8), listed(7)],
        retentionDays: 30,
        asset: (file: string) => file,
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
        absoluteUrl,
        csrfToken: "t",
        cspNonce: "n",
        searchQuery: "",
        req: {
          path: "/comments/7/source",
          originalUrl: "/comments/7/source",
          query: {},
          params: {},
          session: { user: { role: "ADMIN" } },
          flash: () => ({}),
        },
        ...locals,
      },
      { root: VIEWS, views: [VIEWS] },
    );
  }

  it("says how many comments would go, and how many replies with them", async () => {
    const { document } = new JSDOM(await renderReview()).window;
    const summary = document.querySelector("main section p")!.textContent!;

    expect(summary.replace(/\s+/g, " ")).toContain(
      "3 comments were posted from the same source",
    );
    expect(summary.replace(/\s+/g, " ")).toContain("2 replies");
  });

  // The button is the only thing on the page that deletes, so its label
  // says exactly what it does, count included.
  it("deletes through a POST with the CSRF token and a label that says what it does", async () => {
    const { document } = new JSDOM(await renderReview()).window;
    const form = document.querySelector<HTMLFormElement>(
      'form[action="/comments/7/source/delete"]',
    )!;

    expect(form).not.toBeNull();
    expect(form.method.toLowerCase()).toBe("post");
    expect(
      form.querySelector<HTMLInputElement>('input[name="_csrf"]')!.value,
    ).toBe("t");
    expect(form.querySelector("button")!.textContent!.replace(/\s+/g, " ").trim()).toBe(
      "Delete all 3 comments from this source",
    );
  });

  it("lists the comments it would delete, escaped like everywhere else", async () => {
    const { document } = new JSDOM(
      await renderReview({
        total: 2,
        comments: [
          listed(9, { nick: "<b>loud</b>", snippet: "<script>alert(1)</script>" }),
          listed(8),
        ],
      }),
    ).window;
    const items = document.querySelectorAll(".comment-feed-item");

    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector(".comment-nick")!.textContent).toBe(
      "<b>loud</b>",
    );
    expect(items[0]!.querySelector(".comment-content script")).toBeNull();
    expect(
      items[0]!.querySelector<HTMLAnchorElement>(".comment-feed-link")!.href,
    ).toContain("/doom#comment-9");
  });

  // The list is capped; the count above it is not, and the page says so.
  it("says when it is showing only the newest of them", async () => {
    const shortList = new JSDOM(await renderReview({ total: 120 })).window
      .document;
    const fullList = new JSDOM(await renderReview()).window.document;

    expect(shortList.querySelector("main")!.textContent).toContain(
      "The newest 3 of them",
    );
    expect(fullList.querySelector("main")!.textContent).not.toContain(
      "The newest",
    );
  });

  it("does not ask to be indexed", async () => {
    const { document } = new JSDOM(await renderReview()).window;

    expect(
      document.querySelector('meta[name="robots"]')!.getAttribute("content"),
    ).toContain("noindex");
  });
});

/**
 * A thread sends its newest REPLIES_PER_ROOT replies (models/comment.ts), so
 * the ones left out are the oldest — and the note saying so belongs above the
 * replies it is older than. It used to sit below them, about replies that were
 * then really the newest ones.
 */
describe("the note about replies the cap left out", () => {
  it("comes before the replies it is older than", async () => {
    const html = await renderComment({
      hiddenReplies: 3,
      replies: [
        {
          id: 2,
          nick: "b",
          content: "a later reply",
          createdAt: new Date("2024-01-02T00:00:00Z"),
          parentId: 1,
          replies: [],
        },
      ],
    });
    const { document } = new JSDOM(html).window;
    const thread = document.getElementById("replies-1")!;

    expect(thread.firstElementChild!.classList).toContain(
      "comment-replies-hidden",
    );
    expect(thread.querySelector(".comment-replies-hidden")!.textContent).toMatch(
      /3 older replies are not shown/,
    );
  });
});
