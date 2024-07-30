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
 * reads off `error` in a JSON body — but which views/comments/comment-form.ejs
 * *also* submits as an ordinary form when scripts are off.
 *
 * That is why this path is negotiated per request rather than listed
 * unconditionally, which is what it used to be. Every refusal of a comment
 * post was answered in JSON, so a visitor with no JavaScript who left the page
 * open past the lifetime of the CSRF cookie was shown the raw text
 * `{"error":"Your session has expired..."}` as a document — and the route's
 * own 400, 404 and 409 answers did the same. validations/comments.ts had
 * already worked this out and negotiates in its reject(); the two halves of
 * one endpoint disagreed about what a browser is.
 *
 * A success is a rendered comment rather than an object, but that is not what
 * this decides: it names the endpoints whose *errors* belong in JSON.
 *
 * Method-aware, because GET /comments is the site-wide overview and is a page.
 */
const JSON_NEGOTIATED_POST_PATHS = ["/comments"];

/**
 * Whether *this particular request* came from a script that wants an object
 * back, as opposed to a browser that wants a page.
 *
 * The content type first, because it is the one signal that cannot be
 * accidental: a body sent as JSON was built by code. comments.js and
 * rating-stars.js both send one, and a browser submitting a form never does.
 *
 * The Accept header second, and only when it names JSON *ahead of* HTML. A
 * bare fetch() sends the wildcard, which accepts a page just as happily — so
 * treating "accepts JSON" as "wants JSON" would put every ordinary navigation
 * on the JSON path. req.accepts returns the client's preferred of the two,
 * which is the question worth asking.
 *
 * Both calls are optional, and the default when neither answers is "a page".
 * This is reached from the 404 and 500 handlers in app.ts, which are the last
 * thing between an error and a response, and it is reached with objects that
 * are request-shaped rather than Express Requests — a client too old to send
 * an Accept header at all is the same case. A request that cannot say what it
 * wants is not a script, and a page is the answer a browser can read.
 *
 * Exported so a route can answer the way its errors will be answered — see
 * routes/comments.ts, where the success path has to make the same choice.
 */
export function isJsonRequest(req: Request): boolean {
  if (req.is?.("json")) return true;

  return req.accepts?.(["html", "json"]) === "json";
}

export function expectsJson(req: Request): boolean {
  if (JSON_PATHS.includes(req.path)) return true;

  if (
    req.method === "POST" &&
    JSON_NEGOTIATED_POST_PATHS.includes(req.path)
  ) {
    return isJsonRequest(req);
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
