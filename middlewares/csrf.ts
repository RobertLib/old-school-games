import crypto from "crypto";
import { type Request, type Response, type NextFunction } from "express";
import { readCookie } from "../utils/cookies.ts";
import { expectsJson } from "../utils/expects-json.ts";
import { SITE_URL } from "../utils/site.ts";
import "../types/session.ts";

/**
 * CSRF protection by double submit: the secret lives in a cookie another
 * origin cannot read, and every unsafe request has to echo it back in the
 * form body or a header.
 *
 * It used to live in the session, which meant express-session persisted a row
 * for every visitor — including every crawler that will never submit
 * anything — purely to hold a token nobody would use.
 */

const SECURE = process.env.NODE_ENV === "production";

// The "__Host-" prefix stops a subdomain, or anything speaking plain HTTP,
// from planting a secret of its own, which is what makes double submit safe.
// The prefix requires Secure, so development over HTTP uses the bare name.
export const CSRF_COOKIE = SECURE ? "__Host-osg_csrf" : "osg_csrf";

/** The secret as it is held in the cookie: 32 bytes, hex-encoded. */
const SECRET_BYTES = 32;
const SECRET_PATTERN = /^[0-9a-f]{64}$/;

/** A masked secret: the pad and the ciphertext, both hex, back to back. */
const MASKED_PATTERN = /^[0-9a-f]{128}$/;

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The methods that change nothing, and therefore the only ones this lets past
 * unchecked.
 *
 * One allowlist rather than an allowlist here and a denylist in validateCsrf,
 * which is what there used to be: "POST, PUT, PATCH, DELETE" named the methods
 * to guard, so anything outside both sets — TRACE, a WebDAV PROPFIND, a
 * router.all() added later — was neither safe nor unsafe and skipped the token
 * check entirely. Written this way an unknown method is validated, which is
 * the only direction a mistake here can safely fall.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether an unsafe request announces an origin that is not this site's.
 *
 * Defence in depth behind the token, not instead of it. The token is what
 * actually stops a forged submit; this catches the cases where the token check
 * could be sidestepped without the attacker ever being able to read a
 * response — a bug in the masking, a secret leaked into a page, a browser or
 * proxy that mishandles the "__Host-" prefix — and it costs one string
 * comparison.
 *
 * A missing Origin is allowed through, because it is not evidence of anything.
 * Current browsers send it on every POST, same-origin form posts included (see
 * the Referrer-Policy in app.ts, which decides what they write in it), but
 * older ones omitted it on a same-origin form post — the no-JavaScript comment
 * form is one — and the non-browser callers that matter here — the suite,
 * curl, a health checker — send nothing either. Requiring it would refuse
 * submits this site is built to accept.
 *
 * Production only. Development and the suite run on localhost under any number
 * of ports and hostnames, and SITE_URL names the live origin, so comparing
 * against it outside production would refuse every form post on a developer's
 * machine. `req.headers.origin` arriving as an array cannot equal a string,
 * which is the right answer for a header nobody legitimately repeats.
 */
function hasForeignOrigin(req: Request): boolean {
  if (process.env.NODE_ENV !== "production") return false;

  const origin = req.headers.origin;

  if (origin === undefined) return false;

  return origin !== SITE_URL;
}

/**
 * The one unsafe request let through without a token: a logout that proves
 * it was sent by a page of this site.
 *
 * The login rotates the CSRF secret (see routes/auth.ts), which is right, and
 * which leaves every tab opened before the login holding a page whose token
 * masks the old secret. Any form submitted from one of those is refused with
 * the "expired" 403 below until the tab is reloaded — an accepted cost for a
 * comment or an admin form, because the refusal says what to do about it. For
 * the logout it said the wrong thing entirely: "your session has expired",
 * while the session behind it stayed signed in for its full week. On a shared
 * machine that reads as logged out, and it is not.
 *
 * A token is not what a logout needs to be safe. What a forged logout costs
 * the victim is being signed out; what stops a page elsewhere from causing it
 * is that its cross-site POST arrives without the session cookie (SameSite=Lax,
 * see utils/session-cookie.ts) and carrying its own origin, which
 * hasForeignOrigin above refuses outright. So a logout is accepted on proof of
 * the same thing the token would have proven — that a page of this site sent
 * it — in the one form a browser gives that proof: an Origin header naming this
 * site exactly.
 *
 * Proof, not the absence of evidence. hasForeignOrigin lets a missing Origin
 * through to the token check because absence shows nothing either way; here,
 * for the same reason, a missing Origin is not proof and the token is still
 * required. A current browser sends one on the logout form's POST, so this is
 * the ordinary case for a real logout rather than a lucky one; an older one
 * that sends none is where it was before, refused until the tab is reloaded.
 *
 * Production only, like hasForeignOrigin, and for its reason: SITE_URL names
 * the live origin, and outside production there is nothing to hold a request's
 * Origin against. A stale-tab logout on a developer's machine still gets the
 * 403.
 *
 * `req.path` is the whole path here — validateCsrf is mounted on the app, not
 * inside a router — so this is the logout route and nothing that merely ends
 * in its name.
 */
function isOwnLogout(req: Request): boolean {
  return (
    process.env.NODE_ENV === "production" &&
    req.method === "POST" &&
    req.path === "/logout" &&
    req.headers.origin === SITE_URL
  );
}

function xorBytes(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(SECRET_BYTES);

  for (let index = 0; index < SECRET_BYTES; index++) {
    out[index] = a[index]! ^ b[index]!;
  }

  return out;
}

/**
 * Hides the secret behind a fresh one-time pad, so that no two responses
 * carry the same bytes for it.
 *
 * The rendered token used to be the secret itself, sitting in a <meta> tag on
 * every page — and every page also echoes the visitor's own "?search=" back
 * into the navbar's search box, with compression turned on over the whole
 * response. That is the BREACH setup: an attacker who can make a browser ask
 * for "/?search=<guess>" repeatedly learns from the compressed length whether
 * the guess appears elsewhere in the document, and recovers the secret a
 * character at a time.
 *
 * A pad drawn per response breaks the correlation the attack depends on:
 * there is no longer a stable string in the body to compress a guess against.
 * The cookie is untouched, so the secret itself is unchanged and every token
 * already in a browser keeps working.
 */
export function maskToken(secret: string): string {
  const pad = crypto.randomBytes(SECRET_BYTES);
  const masked = xorBytes(pad, Buffer.from(secret, "hex"));

  return pad.toString("hex") + masked.toString("hex");
}

/** The secret behind a masked token, or null if this is not one. */
function unmaskToken(submitted: string): string | null {
  if (!MASKED_PATTERN.test(submitted)) return null;

  const pad = Buffer.from(submitted.slice(0, 64), "hex");
  const masked = Buffer.from(submitted.slice(64), "hex");

  return xorBytes(pad, masked).toString("hex");
}

/**
 * Writes the secret cookie, whatever the secret is.
 *
 * Split out of csrfToken below because issueCsrfSecret needs the identical
 * attributes: a cookie sent with a different path or SameSite is a *second*
 * cookie as far as the browser is concerned, and the two would then be
 * returned in an order nothing here controls.
 */
function sendSecret(res: Response, secret: string): void {
  res.cookie(CSRF_COOKIE, secret, {
    httpOnly: true,
    sameSite: "lax",
    secure: SECURE,
    path: "/",
    maxAge: ONE_MONTH_MS,
  });
}

/**
 * Mints a fresh secret, replacing whatever the browser was carrying, and
 * puts a token for it on the response.
 *
 * For the two moments where the identity behind the session changes: the
 * login that regenerates the session, and the logout that destroys it (see
 * routes/auth.ts). express-session regenerates its own id there precisely so
 * that a value an attacker planted before the login cannot be used after it
 * — and the CSRF secret is the other half of that pair. It lives in a cookie
 * of its own rather than in the session, so nothing about regenerating the
 * session touches it: without this, a secret fixed onto the browser before
 * the login stayed valid across it, and whoever knew it could mint tokens
 * that the now-privileged session accepts.
 *
 * res.locals is updated as well as the cookie, because the response that
 * calls this may still render a page — a token masking the *old* secret
 * would be refused by the very next submit.
 *
 * Pages rendered earlier, in other tabs, are beyond its reach: their tokens
 * mask the old secret, and a form submitted from one is refused until the tab
 * is reloaded. That is the cost of rotating, accepted everywhere except the
 * logout — see isOwnLogout.
 */
export function issueCsrfSecret(req: Request, res: Response): string {
  const secret = crypto.randomBytes(SECRET_BYTES).toString("hex");

  sendSecret(res, secret);

  req.csrfToken = secret;
  res.locals.csrfToken = maskToken(secret);

  return secret;
}

export function csrfToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  let secret = readCookie(req.headers.cookie, CSRF_COOKIE);

  if (!secret || !SECRET_PATTERN.test(secret)) {
    // Minted on safe methods only. The cookie is SameSite=Lax, so a top-level
    // POST from another site arrives without it; minting a secret here
    // would Set-Cookie it over the one the visitor's open tabs were issued
    // tokens for, and their next submit failed with the "expired" 403 below
    // — a nuisance any other page could inflict. An unsafe request with no
    // secret carries no token that could match, so validateCsrf refuses it
    // either way, and the next GET issues a fresh secret.
    if (!SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    // A known race, accepted, and written down here rather than discovered
    // again from a bug report.
    //
    // A browser with no cookie at all — a first visit, or one after the cookie
    // was cleared — usually asks for several things at once, and every one of
    // those requests that reaches this middleware finds nothing and mints a
    // secret of its own. The browser keeps whichever Set-Cookie arrives last,
    // while the page it renders carries a token masking whichever secret *that*
    // response minted; when the two are different responses, the first form the
    // visitor submits is refused with the 403 in validateCsrf below.
    //
    // Closing it means the concurrent requests agreeing on one secret, and
    // there is nowhere for them to agree. The secret lives in a cookie rather
    // than in the session precisely so that express-session does not persist a
    // row for every visitor who will never submit anything (see the note at the
    // top of this file), and every fix puts that server-side state back: a row,
    // or a shared store keyed on the only thing a cookieless browser's requests
    // have in common, which is an IP address.
    //
    // The cost is one reload, once, on a first visit: from the next request
    // onwards a cookie exists, this branch is not taken, and the re-send below
    // keeps it alive. That is cheaper than the state, so it stays.
    secret = crypto.randomBytes(SECRET_BYTES).toString("hex");
  }

  /**
   * Sent on every response, not only the one that mints a secret.
   *
   * The cookie lives a month from when it was *issued*, and issuing only
   * happened when there was none — so a visitor who comes back weekly, and is
   * therefore never without one, still lost it a month to the day after their
   * first visit. The next form they submitted was refused: the page carried a
   * token masking a secret the browser no longer held. That is the 403 the
   * refusal text below apologises for, and it was reachable by doing nothing
   * wrong at all.
   *
   * Re-sending the *same* secret slides the expiry without rotating it, which
   * is the distinction that matters: a fresh secret would invalidate every
   * token already rendered into a page someone has open, which is the very
   * failure this is fixing. A month of inactivity still expires it.
   *
   * The cost is one Set-Cookie header per response, and only on responses that
   * reach this far. Everything cacheable — the static assets, robots.txt, the
   * sitemap and both feeds — is answered above this middleware, and everything
   * below it already carries "Cache-Control: private, no-cache" (see app.ts),
   * so there is no shared cache for the header to confuse.
   */
  sendSecret(res, secret);

  // The secret on the request, for validateCsrf to compare against; a masked
  // copy on the response, which is the only form that reaches a template.
  req.csrfToken = secret;
  res.locals.csrfToken = maskToken(secret);

  next();
}

/** Constant-time, so a mismatch cannot be probed a byte at a time. */
function matches(submitted: string, expected: string | undefined): boolean {
  if (!expected) return false;

  const submittedBytes = Buffer.from(submitted, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");

  // Byte length, not string length: "é" is one character but two bytes, so a
  // token of 64 multi-byte characters used to clear a `.length` check and then
  // make timingSafeEqual throw, turning a forged token into a 500 instead of
  // the 403 it deserves.
  if (submittedBytes.length !== expectedBytes.length) return false;

  return crypto.timingSafeEqual(submittedBytes, expectedBytes);
}

export function validateCsrf(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // The allowlist, not the denylist of unsafe methods this used to test: a
  // method in neither set — TRACE, a WebDAV PROPFIND, a router.all() someone
  // adds later — fell through to next() and was never checked at all. Asking
  // whether the method is *safe* means an unknown one is validated, which is
  // the same direction csrfToken above and middlewares/voter-id.ts already
  // decide in.
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  // `||`, not `??`: a form that posts an empty "_csrf" — a template that
  // rendered before csrfToken ran, or a client that sends the field
  // unconditionally — used to suppress the header fallback, so a request
  // carrying a perfectly good X-CSRF-Token was refused because the body also
  // carried "". An empty field says nothing; the header is the only value
  // present, so it is the one to check.
  const submitted =
    (req.body as Record<string, string> | undefined)?._csrf ||
    req.headers["x-csrf-token"];

  /**
   * A masked token, and nothing else.
   *
   * The bare secret used to be accepted alongside it, so that a page
   * rendered before masking existed did not stop working. That window closed
   * long ago — the cookie lives a month, and no template has rendered an
   * unmasked token since — and leaving the path open kept the BREACH
   * mitigation only half in force: the point of masking is that the bytes
   * standing for the secret differ in every response, which buys nothing
   * while the response is also willing to accept the stable form.
   *
   * unmaskToken returns null for anything that is not 128 hex characters, so
   * a bare 64-character secret now lands in the refusal below with
   * everything else that is not a token this app issued.
   */
  const candidate =
    typeof submitted === "string" ? unmaskToken(submitted) : null;

  // The same refusal as a bad token, deliberately: the two are the same class
  // of request and giving them separate answers would only tell a prober which
  // check it tripped.
  if (
    hasForeignOrigin(req) ||
    candidate === null ||
    !matches(candidate, req.csrfToken)
  ) {
    // Only once the token has failed, so a logout carrying a good token is
    // still judged by the token like everything else. See isOwnLogout.
    if (isOwnLogout(req)) {
      next();
      return;
    }

    // An object for the endpoints answered over fetch, for the same reason the
    // rate limiters send one: their clients read the reason off `error` in a
    // JSON body, and a plain-text 403 made response.json() throw — so the
    // visitor was shown the generic "Could not post the comment" / "Failed to
    // submit rating", the one message that does not say what to do about it.
    //
    // Reloading is what fixes this, and it is worth saying: the request that
    // lands here is usually one sent from a page older than the secret backing
    // it — a page left open longer than the cookie's month, or, far more
    // often, one opened in another tab before a login or a logout rotated the
    // secret (see issueCsrfSecret). Reloading renders a token for the secret
    // the browser holds now.
    if (expectsJson(req)) {
      res.status(403).json({
        error: "Your session has expired — please reload the page and retry.",
      });
      return;
    }

    // The site's own 403 page rather than the bare line of text this used to
    // answer with. A refused form post is the one refusal an ordinary visitor
    // actually meets — a page left open in a tab from before the secret it
    // was rendered with was replaced — and "Invalid CSRF token" on a blank
    // white page names a mechanism rather than telling them the one thing that
    // fixes it.
    //
    // app.ts puts the middleware that sets res.locals.req above this one so
    // the layout can render here; the sidebar locals it has not loaded are
    // defaulted inside the partials themselves.
    res.status(403).render("403", {
      noindex: true,
      message:
        "Your session has expired — please reload the page and submit again.",
    });
    return;
  }

  next();
}
