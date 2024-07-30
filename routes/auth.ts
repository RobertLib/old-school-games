import express from "express";
import { fakeVerifyPassword, verifyPassword } from "../utils/password.ts";
import rateLimit from "express-rate-limit";
import User from "../models/user.ts";
import {
  PostgresRateLimitStore,
  rateLimitLogger,
} from "../utils/rate-limit-store.ts";
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "../utils/session-cookie.ts";
import "../types/session.ts";
import crypto from "crypto";

const router = express.Router();

/**
 * The account a login attempt is for, as a rate-limit key.
 *
 * Hashed rather than stored as typed: the "rate_limits" table is not the
 * place to keep a list of the addresses people have tried to log in as, and
 * a fixed 64 characters cannot overflow the key column. Lower-cased and
 * trimmed first, because that is how User.findByEmail matches it — a caller
 * rotating the case of one address is still hitting one account.
 */
function accountKey(req: express.Request): string {
  const email = String(req.body?.email ?? "")
    .trim()
    .toLowerCase();

  return crypto.createHash("sha256").update(email).digest("hex");
}

function hasEmail(req: express.Request): boolean {
  return typeof req.body?.email === "string" && req.body.email.trim() !== "";
}

// Shared across machines: ten attempts per quarter hour is a security
// control, and an in-memory count made it ten per machine — so scaling out
// would quietly have widened it.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,

  /**
   * Failed attempts, not attempts.
   *
   * The budget is a brake on guessing, and a login that succeeded is not a
   * guess — but it was spending the same budget, and the budget is shared by
   * everyone behind one address. An admin who mistyped their password twice
   * and then got it right had three of their ten gone for the next quarter
   * hour, and an office or a school behind a single NAT reached the limit on
   * ordinary use: ten *logins* locked the door for everybody there, with the
   * message blaming attempts nobody had made.
   *
   * The library gives the hit back when the response says the request worked,
   * which here is exactly the distinction the statuses below already draw —
   * 400 for a malformed post, 401 for a refused credential, 302 for a login
   * that went through. That is why those statuses had to be right first: on
   * the 200 this route used to answer for a *rejected* login, this option
   * would have refunded the guess and made the limiter count nothing at all.
   *
   * The refund runs off the response's "finish" event, outside the middleware
   * and unguarded by `passOnStoreError` — see the note on decrement() in
   * utils/rate-limit-store.ts, which is what keeps a database blip there from
   * taking the process down.
   */
  skipSuccessfulRequests: true,

  message: "Too many login attempts, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresRateLimitStore("login"),
  // Fails closed, unlike every other limiter on the site. Those pass on a
  // store error because a blanked widget beats a dead page; this one guards
  // the admin login, and "the database is unwell" is exactly the moment a
  // brute-force attempt should not get to run unthrottled. A login that
  // answers 500 for the length of a blip is the cheaper failure.
  passOnStoreError: false,
  // ...and says so through utils/logger.ts rather than the library's
  // own console fallback — see rateLimitLogger.
  logger: rateLimitLogger,
});

/**
 * The same brake keyed on the account rather than the address.
 *
 * Per-IP alone hands an attacker rotating addresses ten fresh guesses per
 * address at one account, indefinitely. Twenty failures an hour against one
 * account, from wherever they come, is generous for a person who has
 * forgotten a password and hopeless for a wordlist. Requests with no email at
 * all skip it — they are refused with a 400 before a password is looked at.
 */
const accountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: accountKey,
  skip: (req) => !hasEmail(req),
  message: "Too many login attempts for this account, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresRateLimitStore("login-account"),
  passOnStoreError: false,
  logger: rateLimitLogger,
});

/**
 * Every response below renders the login form, and none of them is worth
 * indexing.
 *
 * It replaces "Disallow: /login" in robots.txt, which could not do this job:
 * views/footer.ejs links the form from every page on the site, and a URL that
 * is blocked from crawling but linked to is precisely the one Google may
 * index from the links alone — the tag saying not to sits behind the block,
 * where nothing ever reads it. Same trade as the search URLs, which
 * routes/sitemap.ts settles the same way and at length.
 */
router.use("/login", (req, res, next) => {
  res.locals.noindex = true;
  next();
});

router.get("/login", async (req, res) => {
  res.render("auth/login");
});

router.post("/login", loginLimiter, accountLimiter, async (req, res, next) => {
  const { email, password } = req.body;

  // Typed, not merely truthy: "email[]=a&email[]=b" arrives as an array, which
  // a bare falsy check let through — scrypt then threw on the non-string
  // password, a 500 for what is only a malformed form post.
  // 400 and 401 rather than the 200 all three of these used to answer with.
  // A rejected login is not a successful request, and saying so is not
  // pedantry: a 200 is what a password manager reads as "that worked", so it
  // offers to save the credentials that were just refused, and it is what
  // anything counting failed logins in an access log cannot see at all.
  // The body is unchanged — the form comes back with its message either way.
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !email ||
    !password
  ) {
    return res.status(400).render("auth/login", {
      error: "All fields are required.",
    });
  }

  const user = await User.findByEmail(email);

  if (!user) {
    // Same work as a real check, so the response time cannot be used to tell
    // which addresses have an account here.
    await fakeVerifyPassword(password);

    return res.status(401).render("auth/login", {
      error: "Invalid credentials.",
    });
  }

  const valid = await verifyPassword(password, user.password);

  if (!valid) {
    return res.status(401).render("auth/login", {
      error: "Invalid credentials.",
    });
  }

  const userData = { id: user.id, email: user.email, role: user.role };

  req.session.regenerate((err) => {
    if (err) return next(err);

    req.session.user = userData;
    res.redirect("/");
  });
});

// POST, not GET. Logging out changes state, and validateCsrf only guards the
// unsafe methods — so as a GET any other site could end an admin's session
// with an <img src="/logout">.
router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    // destroy() drops the row in the session store but says nothing to the
    // browser, so the cookie stayed put and was sent on every later request
    // — pointing at a session that no longer exists. Nothing could be done
    // with it, but it left a visitor who logged out still carrying an id.
    // The attributes have to match the ones it was set with or the browser
    // keeps it; both sides read them from the same constant.
    res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);

    res.redirect("/");
  });
});

export default router;
