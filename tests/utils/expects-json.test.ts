import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { expectsJson } from "../../utils/expects-json.ts";

const req = (method: string, path: string) =>
  ({ method, path }) as unknown as Request;

/**
 * Decides whether a 404 or an unhandled error is answered in JSON or with a
 * page. Getting it wrong in either direction is a real failure: a fetch()
 * handed an HTML document reports "Unexpected token '<'", and a visitor handed
 * {"error":"Not found"} sees raw JSON where a page belonged.
 */
describe("expectsJson", () => {
  describe("JSON endpoints", () => {
    it("covers the collection endpoint the favourites lists hydrate from", () => {
      expect(expectsJson(req("GET", "/games/collection"))).toBe(true);
    });

    it("covers the ratings endpoint every page with stars calls", () => {
      expect(expectsJson(req("GET", "/games/my-ratings"))).toBe(true);
    });

    it("covers rating and play, which answer in JSON", () => {
      expect(expectsJson(req("POST", "/games/12/rate"))).toBe(true);
      expect(expectsJson(req("POST", "/games/12/play"))).toBe(true);
    });

    it("covers the comment batch endpoint", () => {
      expect(expectsJson(req("GET", "/comments/12"))).toBe(true);
      expect(expectsJson(req("GET", "/comments/12/anything"))).toBe(true);
    });

    /**
     * comments.js posts here over fetch and reads a refusal off `error` in
     * the body. It was missing, so the one rejection that comes from neither
     * the route nor its validator — a failed CSRF check — arrived as a
     * plain-text body the client could not parse, and the reader was shown
     * the generic "Could not post the comment" instead.
     *
     * A success here is a rendered comment rather than an object; what this
     * function decides is where the *errors* go.
     */
    it("covers posting a comment", () => {
      expect(expectsJson(req("POST", "/comments"))).toBe(true);
    });
  });

  describe("pages", () => {
    it("leaves ordinary pages alone", () => {
      expect(expectsJson(req("GET", "/"))).toBe(false);
      expect(expectsJson(req("GET", "/doom"))).toBe(false);
      expect(expectsJson(req("GET", "/no-such-page"))).toBe(false);
    });

    // The site-wide overview is a page, and has no trailing slash — which is
    // what keeps it out of the /comments/ prefix above.
    it("leaves the comments overview as a page", () => {
      expect(expectsJson(req("GET", "/comments"))).toBe(false);
    });

    // Same path, different method: the overview is rendered, the post is not.
    it("does not extend the comment post to the paths below it", () => {
      expect(expectsJson(req("POST", "/comments/12"))).toBe(false);
    });

    // A form post that flashes a message and redirects. It shares its prefix
    // with the JSON batch endpoint, which is why the check reads the method.
    it("leaves comment moderation on the redirect path", () => {
      expect(expectsJson(req("POST", "/comments/12/delete"))).toBe(false);
    });

    it("leaves the admin game forms as pages", () => {
      expect(expectsJson(req("GET", "/games/new"))).toBe(false);
      expect(expectsJson(req("POST", "/games/12"))).toBe(false);
      expect(expectsJson(req("POST", "/games/12/delete"))).toBe(false);
    });

    // Only the two exact paths are JSON; anything below them is not a route.
    it("does not extend the fixed paths to their children", () => {
      expect(expectsJson(req("GET", "/games/my-ratings/extra"))).toBe(false);
      expect(expectsJson(req("GET", "/games/collection/extra"))).toBe(false);
    });

    // The rate and play endpoints are POST-only.
    it("does not treat a GET of a POST-only action as JSON", () => {
      expect(expectsJson(req("GET", "/games/12/rate"))).toBe(false);
    });
  });
});
