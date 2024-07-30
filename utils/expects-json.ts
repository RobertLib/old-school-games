import { type Request } from "express";

/**
 * Whether a request belongs to an endpoint that answers with JSON rather than
 * a page.
 *
 * The 404 and 500 handlers used to render their views unconditionally, so a
 * fetch() that missed — or that hit a route which threw before its own
 * try/catch could answer — was handed a whole HTML document where it expected
 * an object, and reported whatever "Unexpected token '<'" it made of it.
 *
 * The list is explicit rather than read off the Accept header, because a bare
 * fetch() accepts anything at all: content negotiation would put every one of
 * these back on the HTML path.
 */
const JSON_PATHS = ["/games/collection", "/games/my-ratings"];

/** POST /games/:id/rate and /games/:id/play both answer in JSON. */
const JSON_GAME_ACTIONS = /^\/games\/[^/]+\/(rate|play)$/;

/**
 * Posting a comment, which comments.js sends over fetch and whose refusals it
 * reads off `error` in a JSON body. It was missing here, so the only rejection
 * that did not come from the route or its validator — a failed CSRF check —
 * arrived as a plain-text body the client could not parse.
 *
 * A success is a rendered comment rather than an object, but that is not what
 * this decides: it names the endpoints whose *errors* belong in JSON.
 *
 * Method-aware, because GET /comments is the site-wide overview and is a page.
 */
const JSON_POST_PATHS = ["/comments"];

export function expectsJson(req: Request): boolean {
  if (JSON_PATHS.includes(req.path)) return true;

  if (req.method === "POST" && JSON_POST_PATHS.includes(req.path)) {
    return true;
  }

  if (req.method === "POST" && JSON_GAME_ACTIONS.test(req.path)) {
    return true;
  }

  // Method-aware on purpose: GET /comments/:gameId is the JSON batch
  // endpoint, while POST /comments/:id/delete is an ordinary form post that
  // belongs on the flash-and-redirect path. GET /comments itself — the
  // site-wide overview — is a page, and does not have the trailing slash.
  return req.method === "GET" && req.path.startsWith("/comments/");
}
