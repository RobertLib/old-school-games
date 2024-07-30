import { type Request, type Response, type NextFunction } from "express";
import User from "../models/user.ts";
import { holdsCredential } from "../utils/session-credential.ts";
import { endSession } from "../utils/session-cookie.ts";
import "../types/session.ts";

/**
 * Confirms the request comes from an admin, asking the database rather than
 * the session.
 *
 * The role used to be read straight off req.session.user, where the login
 * route had written it — so taking someone's admin rights away in the
 * database did nothing at all until their cookie ran out. That is seven days
 * (see the maxAge in app.ts), and seven days of *not using the site*: the
 * session is rolling, so every request an admin makes starts the week again
 * and a demoted admin who keeps working is never logged out by it at all.
 * There is no way to reach into express-session and rewrite a row already
 * issued to a browser, so the only way for a revocation to take effect is to
 * stop trusting the copy.
 *
 * One query, and only on the admin routes: the game and news forms, the
 * moderation endpoints. Nothing a visitor reaches goes through this.
 *
 * The same row answers a second question: whether the session was opened with
 * the password the account has now. A password reset used to end a stolen
 * session only by deleting its row, which is undone by anything that puts the
 * row back — and with the role re-read by user id, a row that came back was a
 * full admin again. The login records a fingerprint of the password hash in
 * the session (utils/session-credential.ts); a reset stores a new hash, so a
 * session from before it stops matching here whatever became of its row.
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

  // The deleted account: no row means no role, which is not "ADMIN".
  if (!user) {
    refuse(res);
    return;
  }

  /**
   * A session from before the account's current password: signed out, not
   * merely refused.
   *
   * Refusing would leave the session alive — still drawing the admin's
   * controls and the logout button on every page, still slid forward a week
   * by every page view — for an admin who can do nothing with it but find the
   * logout. Ending it sends them to the login form, which is the one thing
   * that helps, and leaves nothing of the old credential in the store.
   *
   * Asked before the role, because a revoked session is revoked whatever its
   * account's role has become since.
   *
   * A session with no credential at all is one of these too. It was written
   * before sessions carried one — every session in production on the day this
   * shipped — and nothing distinguishes it from one that outlived a reset, so
   * its admin is asked to sign in once more; that costs one login and flushes
   * any such row that a reset should already have ended.
   */
  if (!holdsCredential(sessionUser.credential, user.password)) {
    await endSession(req, res);
    res.redirect("/login");
    return;
  }

  if (user.role !== "ADMIN") {
    refuse(res);
    return;
  }

  next();
}
