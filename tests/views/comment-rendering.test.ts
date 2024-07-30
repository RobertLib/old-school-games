import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import type { Request, Response } from "express";
import { validateComment } from "../../validations/comments.ts";

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
  });
});
