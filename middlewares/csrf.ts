import crypto from "crypto";
import { type Request, type Response, type NextFunction } from "express";
import { readCookie } from "../utils/cookies.ts";
import { expectsJson } from "../utils/expects-json.ts";
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
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return next();
  }

  const submitted =
    (req.body as Record<string, string> | undefined)?._csrf ??
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

  if (candidate === null || !matches(candidate, req.csrfToken)) {
    // An object for the endpoints answered over fetch, for the same reason the
    // rate limiters send one: their clients read the reason off `error` in a
    // JSON body, and a plain-text 403 made response.json() throw — so the
    // visitor was shown the generic "Could not post the comment" / "Failed to
    // submit rating", the one message that does not say what to do about it.
    //
    // Reloading is what fixes this, and it is worth saying: the token cookie
    // outlives a month, so the request that lands here is usually one sent
    // from a page older than the cookie backing it.
    if (expectsJson(req)) {
      res.status(403).json({
        error: "Your session has expired — please reload the page and retry.",
      });
      return;
    }

    // The site's own 403 page rather than the bare line of text this used to
    // answer with. A refused form post is the one refusal an ordinary visitor
    // actually meets — a page left open longer than the token cookie lives —
    // and "Invalid CSRF token" on a blank white page names a mechanism rather
    // than telling them the one thing that fixes it.
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
