import { type CookieOptions, type Request, type Response } from "express";
import logger from "./logger.ts";
import "../types/session.ts";

/**
 * The session cookie's name and the attributes it is set with.
 *
 * Both live here rather than inline in app.ts because endSession below needs
 * them to clear the cookie — on logout, and when the admin guard signs out a
 * session whose credential has been replaced — and app.ts imports the routers
 * that reach both: reaching the other way would put them in an import cycle.
 * Clearing only works when the attributes match the ones the cookie was set
 * with, so the two sides reading the same constant is the point, not a
 * tidiness matter.
 *
 * The value is express-session's own default: renaming it would sign out
 * everyone holding a cookie issued before the change, for nothing.
 */
export const SESSION_COOKIE = "connect.sid";

/**
 * Everything about the session cookie except how long it lives.
 *
 * maxAge is deliberately absent: app.ts sets one, and res.clearCookie has to
 * send an expiry in the past instead — passing a future maxAge along would
 * ask the browser to keep the very cookie being deleted.
 */
export const SESSION_COOKIE_OPTIONS: CookieOptions = {
  // express-session defaults to "/" as well; naming it means clearCookie and
  // the cookie it is trying to remove cannot drift apart.
  path: "/",
  httpOnly: true,
  // "lax", not "strict": under strict the cookie is withheld on any
  // cross-site navigation, so an admin following a link to the site from an
  // email or a chat window landed on it logged out, and only appeared
  // logged in once they navigated again from within the site. CSRF is not
  // what this setting is carrying here — validateCsrf guards every unsafe
  // method on its own, and "lax" still withholds the cookie from exactly
  // the cross-site POSTs that would matter.
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
};

/**
 * Ends the request's session: its row in the store, and the cookie naming it.
 *
 * Shared by the two places a session is ended on purpose — the logout, and
 * middlewares/is-admin.ts signing out a session whose credential no longer
 * matches its account — so that the two cannot disagree about what "ended"
 * leaves behind.
 *
 * The row is what makes it final. utils/session-store.ts never re-creates a
 * deleted one, so a request of this session that is still in flight cannot
 * write it back on its way out. That request's response may still carry the
 * rolling Set-Cookie express-session adds to every response — it is written
 * before the save it is waiting on — but the id it names points at nothing,
 * and the next request with it is simply a visitor without a session.
 *
 * A failed destroy is logged, not swallowed, and the session is still ended as
 * far as the browser goes. The error this can carry is the store failing to
 * delete the row — the database being unreachable, most likely — and the
 * callback used to take no argument at all, so that failure was invisible: a
 * session still in the store while the browser has been told to drop its
 * cookie is a row nothing will clean up except the prune timer, and if it
 * happens every time it is the first sign the store is unwell. Handing it to
 * next() instead would be the wrong trade: answering 500 skips clearing the
 * cookie, leaving the visitor who asked to be logged out still carrying a
 * usable one — the worse failure by a distance.
 *
 * The cookie is cleared because destroy() drops the row and says nothing to
 * the browser, so the cookie used to stay put and be sent on every later
 * request, pointing at a session that no longer existed. The attributes have
 * to match the ones it was set with or the browser keeps it — which is what
 * SESSION_COOKIE_OPTIONS above is for.
 */
export function endSession(req: Request, res: Response): Promise<void> {
  return new Promise((resolve) => {
    req.session.destroy((error: unknown) => {
      if (error) logger.error("Session destroy failed:", error);

      res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);

      resolve();
    });
  });
}
