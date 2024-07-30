import { JSDOM } from "jsdom";
import createDOMPurify, { type Config, type WindowLike } from "dompurify";

/**
 * The one DOMPurify the app sanitizes author-supplied HTML with.
 *
 * Game descriptions and news articles are the only two things stored as
 * markup, and each used to build a JSDOM window and a DOMPurify of its own
 * at module load. Both are always loaded together, so that was two full DOM
 * implementations resident for the life of the process to do one job —
 * JSDOM's window is not a cheap object, and nothing about the two call sites
 * differs.
 *
 * Sharing them also means the two can no longer be configured apart by
 * accident: whatever this strips, it strips for both.
 */
const window = new JSDOM("").window;

/**
 * Cast to the shape DOMPurify documents rather than to `any`, which is what
 * this used to say.
 *
 * A cast is unavoidable: WindowLike is built from `typeof globalThis`, and
 * this project compiles with `"lib": ["es2023"]` and no DOM, so the browser
 * globals it picks from are not declared here at all — JSDOM's window supplies
 * them at runtime, but the two type worlds have no overlap for the compiler to
 * check against. Hence the trip through `unknown`.
 *
 * Naming the target still buys something over `any`: this is the one place in
 * the app that decides what author-supplied markup may contain, and `any` also
 * silenced the *call* — an argument in the wrong position, or a DOMPurify that
 * changed what it takes, would have compiled just as happily.
 */
const purify = createDOMPurify(window as unknown as WindowLike);

/**
 * What the sanitizer is asked to do, spelled out rather than left to the
 * defaults.
 *
 * DOMPurify's default configuration is a good one — it already strips
 * <script>, every on*= handler and every javascript: URL, which is what this
 * function has always been for — but it is a default, and it allows two
 * whole markup languages this app has no use for.
 *
 * USE_PROFILES: { html: true } is the narrowing. Out of the box DOMPurify
 * also permits SVG and MathML; nothing here stores either, and SVG in
 * particular is a document format of its own with its own history of
 * sanitizer bypasses (<foreignObject>, <use xlink:href>, animate-driven
 * attribute rewriting). An admin writing a game description or a news
 * article never needs it, so the attack surface is not worth carrying.
 *
 * FORBID_TAGS is about the other half — markup that is perfectly safe by
 * DOMPurify's measure and still has no business in stored content. A <form>
 * inside an article renders a login box that posts wherever its action
 * says, and a visitor cannot tell it from the site's own: this is phishing
 * built out of tags no XSS filter objects to. The same goes for a stray
 * <button> or <input> next to the real controls on a page. Nothing that
 * legitimately appears in a description or an article is on the list — the
 * fixtures in tests are paragraphs, <br>, emphasis and links.
 *
 * Not on the list, because DOMPurify already drops them and the tests
 * covering that would silently start proving the wrong thing: <script>,
 * <iframe>, <object>, <embed> and <base>.
 */
const CONFIG: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "option",
    // Not an oversight in DOMPurify: it allows <style> and sanitizes the CSS
    // inside it. It is refused here anyway, because CSS is an exfiltration
    // channel with no script involved — an attribute selector firing a
    // background request per character reads a value out of the page — and
    // the "style-src" in app.ts, which is what actually blocks a stored
    // <style> today, is one directive away from not doing so. Nothing an
    // author writes needs a stylesheet in the middle of an article.
    "style",
  ],
  /**
   * The style="" attribute, which the directive above does not cover and
   * which nothing else on the way to the page refuses.
   *
   * "style-src" in app.ts blocks a stored <style> element — that is what makes
   * FORBID_TAGS above belt and braces — but "style-src-attr" is deliberately
   * left at 'unsafe-inline', because the layout is built from some three
   * hundred style attributes across twenty-eight templates and the comment on
   * that directive explains why closing it is a visual refactor with no
   * security argument behind it. The consequence lands here: for *stored*
   * markup the sanitizer is the only barrier there is.
   *
   * DOMPurify keeps style attributes by default and sanitizes the CSS inside
   * them, so nothing executable survives one — but plenty that is not
   * executable does. `position: fixed; inset: 0; z-index: 9999` on a
   * paragraph of a news article covers the page with content of the author's
   * choosing, which is a clickjacking surface built entirely out of
   * declarations no XSS filter objects to; `background: url(https://…)` turns
   * every reader of an article into a request at somebody else's server; and
   * `opacity: 0` hides text from a reader while leaving it to a crawler.
   *
   * Nothing an author legitimately writes needs one: descriptions and
   * articles are paragraphs, breaks, emphasis and links, and the site's own
   * stylesheet is what makes them look like the rest of the page.
   */
  FORBID_ATTR: ["style"],
};

/**
 * Strips anything executable out of `html`, leaving the formatting.
 *
 * The result is HTML and is rendered with <%- %>; utils/html-text.ts is what
 * turns it back into the plain text the meta tags and feeds want.
 */
export function sanitizeHtml(html: string): string {
  return purify.sanitize(html, CONFIG);
}
