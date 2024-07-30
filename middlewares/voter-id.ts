import crypto from "crypto";
import { type Request, type Response, type NextFunction } from "express";
import { readCookie } from "../utils/cookies.ts";

export const VOTER_COOKIE = "osg_vid";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Gives every browser a stable anonymous id used to deduplicate game ratings.
 * Ratings used to be keyed by IP address, which meant everyone sharing a
 * mobile-carrier or office NAT overwrote each other's vote.
 *
 * What this does and does not buy, written down because it looks stronger than
 * it is: the id is held by the client, so clearing cookies earns a new one and
 * a fresh vote. It stops a visitor voting twice by accident, not on purpose.
 * The only real brake on deliberate stuffing is the rate limiter in
 * routes/games.ts — 50 ratings per quarter hour per address — and the vote
 * weighting in models/game.ts, which needs a count of votes before it will
 * move a game near the top of a list.
 *
 * Closing it properly needs an identity the server issues and the client
 * cannot discard, which on a site with no accounts means going back to keying
 * by IP — and that is the bug this replaced, not a fix for it. Signing the
 * cookie would not help either: the objection is not that the id can be
 * forged (it is a random v4 UUID behind an httpOnly cookie, so it cannot be
 * guessed or read) but that a new one is free.
 */
export function voterId(req: Request, res: Response, next: NextFunction): void {
  let id = readCookie(req.headers.cookie, VOTER_COOKIE);

  if (!id || !UUID_PATTERN.test(id)) {
    // Minted on safe methods only. The cookie is SameSite=Lax, so a top-level
    // POST from another site — an auto-submitting form is enough — arrives
    // without it, and minting here would have Set-Cookie'd a fresh id over
    // the visitor's year-old one: their dedupe key and "my ratings" gone at
    // any other page's say-so. An unsafe request with no id is refused by the
    // rating route anyway (it needs one), and the next GET issues one.
    if (!SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    id = crypto.randomUUID();
  }

  /**
   * Sent on every response, not only the one that mints an id.
   *
   * The cookie lives a year from when it was *issued*, and issuing only
   * happened when there was none — so a visitor who keeps coming back, and is
   * therefore never without one, still lost it a year to the day after their
   * first visit. What goes with it is every rating they have ever left: the
   * dedupe key is the id, so the next id is a stranger, "my ratings" is empty
   * and every game they had scored is offered to them again unrated. Nobody
   * could have told from the site that anything had happened.
   *
   * Re-sending the *same* id slides the expiry without rotating it, which is
   * the distinction that matters here as much as it does for the CSRF secret
   * (middlewares/csrf.ts, which this mirrors): a fresh id would be that same
   * loss, inflicted deliberately. A year of not visiting at all still expires
   * it, which is the point of a cookie with an end on it.
   *
   * The cost is one Set-Cookie header per response, and only on responses that
   * reach this far — everything cacheable is answered above this middleware,
   * and everything below it carries "Cache-Control: private, no-cache" (see
   * app.ts), so there is no shared cache for the header to confuse.
   */
  res.cookie(VOTER_COOKIE, id, {
    maxAge: ONE_YEAR_MS,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  req.voterId = id;

  next();
}
