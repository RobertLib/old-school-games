import { type Request, type Response, type NextFunction } from "express";
import User from "../models/user.ts";
import "../types/session.ts";

/**
 * Confirms the request comes from an admin, asking the database rather than
 * the session.
 *
 * The role used to be read straight off req.session.user, where the login
 * route had written it — so taking someone's admin rights away in the
 * database did nothing at all until their cookie ran out, which is up to
 * thirty days (see the maxAge in app.ts). There is no way to reach into
 * express-session and rewrite a row already issued to a browser, so the only
 * way for a revocation to take effect is to stop trusting the copy.
 *
 * One query, and only on the admin routes: the game and news forms, the
 * moderation endpoints. Nothing a visitor reaches goes through this.
 *
 * The templates still decide whether to *draw* the edit and delete controls
 * from req.session.user.role, so a demoted admin keeps seeing buttons until
 * their session ends. That is cosmetic — every one of those controls posts to
 * a route guarded here — and making the views accurate would mean this query
 * on every page view rather than on the handful that act.
 */

/**
 * The site's own 403 page, rather than the bare line of text both refusals
 * below used to answer with.
 *
 * Every admin surface behind this guard is a page — the two game forms, the
 * two news forms, comment moderation — so a demoted admin following a button
 * their still-cached session was drawing for them got a blank white document
 * reading "Not authorized". One helper, because both refusals mean the same
 * thing to the person reading them and only differ in which check caught it.
 */
function refuse(res: Response): void {
  res.status(403).render("403", {
    noindex: true,
    message: "You do not have access to that page.",
  });
}

export default async function isAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const sessionUser = req.session?.user;

  if (!sessionUser) {
    refuse(res);
    return;
  }

  let user: User | null;

  try {
    user = await User.findById(sessionUser.id);
  } catch (error) {
    // A lookup that failed is not an authorization. Handing it to the error
    // handler answers 500, where falling back to the session's own claim
    // about the role would turn a database blip into an open admin surface.
    return next(error);
  }

  // Covers the deleted account as well as the demoted one: no row means no
  // role, which is not "ADMIN".
  if (user?.role !== "ADMIN") {
    refuse(res);
    return;
  }

  next();
}
