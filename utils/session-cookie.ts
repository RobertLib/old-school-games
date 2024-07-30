import { type CookieOptions, type Request, type RequestHandler } from "express";
import type { SessionData } from "express-session";
import logger from "./logger.ts";
import "../types/session.ts";

/**
 * The session cookie's name and the attributes it is set with.
 *
 * Both live here rather than inline in app.ts because the response guard below
 * also needs the name. Importing app.ts back from this utility would create an
 * import cycle through the routers which end sessions.
 *
 * The value is express-session's own default, with "__Host-" in front of it
 * in production — the prefix the CSRF cookie already had. Without it, code on
 * any subdomain of the site (a PLAYER_ORIGIN such as play.oldschoolgames.eu is
 * one) could set a "connect.sid" for the whole domain: not read the admin's
 * session, but replace it, signing them out or into a session of its own
 * choosing. A browser takes a "__Host-" cookie only from the host itself,
 * over HTTPS and for Path=/, which SESSION_COOKIE_OPTIONS below already says.
 *
 * Renaming it signed out every administrator once, on the deploy that did it —
 * sessions are only ever admins' (see routes/auth.ts), so that was the whole
 * cost. The prefix requires Secure, so development over HTTP keeps the bare
 * name, as the CSRF and voter cookies do.
 */
export const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-connect.sid" : "connect.sid";

/**
 * Everything about the session cookie except how long it lives.
 *
 * app.ts chooses its fixed browser lifetime; the session store independently
 * enforces the shorter inactivity lifetime.
 */
export const SESSION_COOKIE_OPTIONS: CookieOptions = {
  // Required by the production __Host- prefix, even if library defaults change.
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
 * An existing session must never write its id back to the browser. A delayed
 * response from before logout can otherwise arrive after the next login and
 * overwrite its new id, signing the admin straight back out. Even rolling:
 * false still writes cookies when an expiring session is modified by a flash.
 * Checking the row at response time cannot close a race with response delivery.
 *
 * Only a restored session is protected: a new anonymous session may need
 * its first cookie for a flash, and regenerate() must issue the login's new id.
 * Deletions must be blocked too: a late logout response can otherwise clear the
 * next login's cookie. Other cookies (CSRF, recognised device, voter) keep their
 * ordinary behavior.
 */
export function preventStaleSessionCookie(
  store: { isPersisted(data: SessionData): boolean },
): RequestHandler {
  return (req, res, next) => {
    // The store's marker avoids re-parsing cookies differently from the library
    // (for example, its parser accepts quoted signed cookie values).
    if (!store.isPersisted(req.session)) {
      next();
      return;
    }

    const initialSessionId = req.sessionID;
    const setHeader = res.setHeader;
    const prefix = `${SESSION_COOKIE}=`;

    res.setHeader = function (name, value) {
      if (
        name.toLowerCase() !== "set-cookie" ||
        req.sessionID !== initialSessionId ||
        typeof value === "number"
      ) {
        return setHeader.call(this, name, value);
      }

      const cookies = typeof value === "string" ? [value] : value;
      const kept = cookies.filter((cookie) => !cookie.startsWith(prefix));

      if (kept.length) return setHeader.call(this, name, kept);

      this.removeHeader(name);
      return this;
    };

    next();
  };
}

/**
 * Ends the request's session by deleting its row from the store.
 *
 * Shared by the two places a session is ended on purpose — the logout, and
 * middlewares/is-admin.ts signing out a session whose credential no longer
 * matches its account — so that the two cannot disagree about what "ended"
 * leaves behind.
 *
 * The row is what makes it final. utils/session-store.ts never re-creates a
 * deleted one, so a request of this session that is still in flight cannot
 * write it back on its way out. preventStaleSessionCookie also keeps its
 * response from overwriting a later login's cookie with the deleted id.
 *
 * A failed destroy is logged and rejected. Ignoring a database failure leaves
 * both the row and the browser's usable cookie in place, so resolving would
 * falsely report a successful logout. Logging makes a failing store visible;
 * rejecting lets the caller answer 500 and the admin retry signing out.
 *
 * The opaque cookie is deliberately left behind, unusable without its row.
 * Clearing it from an asynchronous logout would let an old response delete a
 * fresh login cookie. The next login replaces it with a regenerated id.
 */
export function endSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((error: unknown) => {
      if (error) {
        logger.error("Session destroy failed:", error);
        reject(error);
        return;
      }

      resolve();
    });
  });
}
