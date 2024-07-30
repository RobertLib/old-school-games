import { JSDOM } from "jsdom";
import createDOMPurify, { type WindowLike } from "dompurify";

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
 * Strips anything executable out of `html`, leaving the formatting.
 *
 * The result is HTML and is rendered with <%- %>; utils/html-text.ts is what
 * turns it back into the plain text the meta tags and feeds want.
 */
export function sanitizeHtml(html: string): string {
  return purify.sanitize(html);
}
