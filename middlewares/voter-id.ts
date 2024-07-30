import crypto from "crypto";
import { type Request, type Response, type NextFunction } from "express";
import { readCookie } from "../utils/cookies.ts";

export const VOTER_COOKIE = "osg_vid";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
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
    id = crypto.randomUUID();

    res.cookie(VOTER_COOKIE, id, {
      maxAge: ONE_YEAR_MS,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }

  req.voterId = id;

  next();
}
