import { type CookieOptions } from "express";

/**
 * The session cookie's name and the attributes it is set with.
 *
 * Both live here rather than inline in app.ts because routes/auth.ts needs
 * them to clear the cookie on logout, and app.ts imports that router —
 * reaching the other way would put the two in an import cycle. Clearing only
 * works when the attributes match the ones the cookie was set with, so the
 * two sides reading the same constant is the point, not a tidiness matter.
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
