import express from "express";
import {
  fakeVerifyPassword,
  PasswordHashingBusyError,
  verifyPassword,
} from "../utils/password.ts";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import User from "../models/user.ts";
import {
  PostgresRateLimitStore,
  rateLimitLogger,
} from "../utils/rate-limit-store.ts";
import { endSession } from "../utils/session-cookie.ts";
import { credentialOf } from "../utils/session-credential.ts";
import {
  issueDeviceCookie,
  recognisedDevice,
} from "../utils/device-cookie.ts";
import { issueCsrfSecret } from "../middlewares/csrf.ts";
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
 *
 * It is also what a device cookie is bound to (see utils/device-cookie.ts),
 * so the cookie and the limiters cannot disagree about which account an
 * attempt is at.
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

/**
 * The caller's address, normalised the way express-rate-limit's own default
 * key does it — but with IPv6 grouped by /48 rather than the library's /56.
 *
 * ipKeyGenerator rather than req.ip on its own: a single IPv6 client is handed
 * an enormous range by its provider, so keying on the exact address gives one
 * machine as many budgets as it cares to source from. The helper collapses an
 * IPv6 address to a network and leaves IPv4 alone.
 *
 * /48, because /56 was still too many budgets for one party. A /48 is the
 * allocation a site or a hosting customer is routinely given, and inside it
 * are 256 /56s — 256 separate budgets at every limiter on this route, with the
 * site reachable over IPv6 (it has an AAAA record). The wider grouping can put
 * neighbours on one provider's /48 into one budget, and on this route that is
 * the right way round: nobody but the site's administrators has any reason to
 * post here, and the per-address brake exists to be hard to multiply.
 *
 * req.ip is typed optional — Express leaves it undefined when there is no
 * socket behind the request — and an empty string is a key like any other
 * rather than a crash.
 *
 * Both limiters below that count by address key on this one function, so they
 * cannot group one caller differently.
 */
function clientKey(req: express.Request): string {
  return ipKeyGenerator(req.ip ?? "", 48);
}

/**
 * The device cookie a login attempt presents for the account it names, or
 * null — read once per request and remembered, because two limiters below
 * ask for it.
 *
 * Only for the account named: a cookie issued to one account says nothing
 * about an attempt at another, which is what binding the account into the MAC
 * is for.
 */
const recognised = new WeakMap<express.Request, string | null>();

function deviceOf(req: express.Request): string | null {
  let nonce = recognised.get(req);

  if (nonce === undefined) {
    nonce = hasEmail(req) ? recognisedDevice(req, accountKey(req)) : null;
    recognised.set(req, nonce);
  }

  return nonce;
}

// Shared across machines: ten attempts per quarter hour is a security
// control, and an in-memory count made it ten per machine — so scaling out
// would quietly have widened it.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,

  // The library's default key is the address grouped by /56; see clientKey
  // for why this route groups by /48.
  keyGenerator: clientKey,

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
 * The same brake keyed on the account *and* the address it is being attacked
 * from.
 *
 * Per-IP alone hands an attacker rotating addresses ten fresh guesses per
 * address at one account, indefinitely, so a per-account count is needed. But
 * a count keyed on the account alone — twenty an hour, which is what this was
 * — is a lever the other way: the admin's e-mail address is not a secret, and
 * anyone who knows it can spend the whole budget from one machine in a few
 * seconds and keep the real account locked out for as long as they care to
 * keep sending. That is a denial of service handed out for free, and the
 * comment that used to sit here argued the per-account case without ever
 * naming it.
 *
 * Keyed on the pair, one source cannot spend the account's budget: the
 * attacker rotating addresses gets twenty per address at this account instead
 * of ten, which is the hole the per-account count was opened for, and the
 * person who actually owns the address keeps their own twenty whatever anyone
 * else is doing. The backstop below is what still bounds the distributed case.
 *
 * Applied to a recognised device as well: a device cookie lifts the account's
 * backstop, not this.
 *
 * Requests with no email at all skip it — they are refused with a 400 before a
 * password is looked at.
 */
const accountIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${accountKey(req)}:${clientKey(req)}`,
  skip: (req) => !hasEmail(req),
  message: "Too many login attempts for this account, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresRateLimitStore("login-account-ip"),
  passOnStoreError: false,
  logger: rateLimitLogger,
});

/**
 * The budget of a recognised device — the OWASP device cookie's own lockout.
 *
 * An attempt presenting a valid device cookie for the account it names skips
 * the account-wide backstop below; that is the point of the cookie. But the
 * cookie is a bearer token, and on its own the skip would make a stolen one a
 * way around the backstop from as many addresses as the thief has, ten
 * guesses at a time each. So the failures of one device are counted together
 * wherever they come from, and ten in an hour closes that cookie — and only
 * that cookie — until the window ends. The owner mistyping ten times in an
 * hour is the only innocent way to reach it.
 *
 * Keyed on a hash of the cookie's nonce rather than the nonce, so the table
 * holds no part of a value any browser presents.
 */
const deviceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) =>
    crypto
      .createHash("sha256")
      .update(deviceOf(req) ?? "")
      .digest("hex"),
  skip: (req) => deviceOf(req) === null,
  message: "Too many login attempts for this account, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresRateLimitStore("login-device"),
  passOnStoreError: false,
  logger: rateLimitLogger,
});

/**
 * The per-account backstop, and the reason the pair above is safe to key the
 * way it is.
 *
 * A botnet is exactly the case the pair does not cover: every source gets its
 * own twenty, so enough sources are enough guesses. This counts them all
 * together — but at a ceiling ten times higher, because the whole point of
 * moving the tight limit onto the pair was that a lockout must not be
 * something one stranger can inflict cheaply. Two hundred failures an hour
 * against one account is far past anything a person does with a forgotten
 * password and far short of a wordlist.
 *
 * What reaching it costs, worked out rather than assumed — this comment used
 * to say two hundred sources, and it is an order of magnitude fewer. Every
 * source gets ten failures before the per-address limiter above stops it for
 * a quarter of an hour, and twenty an hour at most before the pair does. So
 * twenty sources reach two hundred at once, and ten reach it as soon as a
 * quarter of an hour has passed; a reproduction with twenty-one addresses took
 * under six seconds, after which the real admin, from a fresh address and with
 * the right password, was refused for the rest of the hour — and nothing stops
 * the same twenty doing it again the hour after. With IPv6 that was cheaper
 * still: grouped by /56, one /48 held 256 sources, which is why clientKey now
 * groups by /48.
 *
 * A limit on the account alone cannot be made both tight enough to bound a
 * distributed attack and expensive to trip, so the fix is not a number. It is
 * the device cookie (utils/device-cookie.ts): an attempt that presents one
 * issued by an earlier successful login at this very account skips this
 * limiter and is counted against its own device's budget above instead. The
 * attacker still trips the backstop — for everyone without such a cookie — and
 * the owner, from any browser they have signed in from within the year, is
 * not locked out by it.
 *
 * Same prefix as before ("login-account"), so the key stays a bare hash of the
 * address and the table still holds no list of who has tried to sign in.
 */
const accountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 200,
  skipSuccessfulRequests: true,
  keyGenerator: accountKey,
  skip: (req) => !hasEmail(req) || deviceOf(req) !== null,
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

/**
 * Whether `password` is the password of `user` — and, when there is no such
 * user, the same work as finding out, so the response time cannot be used to
 * tell which addresses have an account here.
 *
 * A recognised device asks for its derivation with priority: it waits for the
 * next free place rather than being turned away with a 503 when the hashing
 * queue is full. A flood that fills the queue is the moment the owner most
 * needs to get in, and every 503 is charged to the limiters like any other
 * refusal — so without this an owner retrying through a flood spent their own
 * device's budget and locked themselves out. See DeriveOptions in
 * utils/password.ts.
 */
async function checkPassword(
  user: User | null,
  password: string,
  priority: boolean,
): Promise<boolean> {
  if (!user) {
    await fakeVerifyPassword(password, { priority });

    return false;
  }

  return verifyPassword(password, user.password, { priority });
}

router.post(
  "/login",
  loginLimiter,
  accountIpLimiter,
  deviceLimiter,
  accountLimiter,
  async (req, res, next) => {
    const { email, password } = req.body;

    // Typed, not merely truthy: "email[]=a&email[]=b" arrives as an array,
    // which a bare falsy check let through — scrypt then threw on the
    // non-string password, a 500 for what is only a malformed form post.
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
        // Only when it is a string. This is the branch a malformed post lands
        // in — "email[]=a&email[]=b" arrives as an array — and handing that to
        // the template would render "a,b" into the field.
        email: typeof email === "string" ? email : "",
      });
    }

    const user = await User.findByEmail(email);

    let valid: boolean;

    try {
      valid = await checkPassword(user, password, deviceOf(req) !== null);
    } catch (error) {
      if (!(error instanceof PasswordHashingBusyError)) throw error;

      /**
       * The process is already hashing as much as it will (see derive in
       * utils/password.ts), so this attempt was refused before any work was
       * done on it — busy, not wrong, and the answer has to say which.
       *
       * 503 with a Retry-After is what a client or a monitor reads as "come
       * back in a moment"; the form is rendered with it because the person
       * who sent it is a person at a browser, and a bare 503 page would not
       * tell them their password was never looked at.
       *
       * Charged to the limiters like any other refusal: the refund is only
       * for a login that went through. A flood of attempts is exactly what
       * produces these, and a flood is what the per-address budget exists to
       * throttle — refunding them would make the requests that load the
       * machine the only ones that cost the sender nothing. The owner's own
       * browser is never answered this way, which is what makes charging it
       * safe: a recognised device queues instead (see checkPassword).
       */
      res.set("Retry-After", String(error.retryAfterSeconds));

      return res.status(503).render("auth/login", {
        error:
          "The server is busy right now, so your password was not checked. Please try again in a moment.",
        email,
      });
    }

    if (!user || !valid) {
      // The address is echoed back, the password is not — see the comment on
      // the field in views/auth/login-form.ejs. Retyping an address to find
      // out it was the password that was wrong is the whole of what this
      // fixes.
      return res.status(401).render("auth/login", {
        error: "Invalid credentials.",
        email,
      });
    }

    const userData = {
      id: user.id,
      email: user.email,
      role: user.role,
      // What middlewares/is-admin.ts compares with the account's current
      // password hash, so that a reset ends this session even if its row
      // were ever to come back — see utils/session-credential.ts.
      credential: credentialOf(user.password),
    };

    req.session.regenerate((err) => {
      if (err) return next(err);

      req.session.user = userData;

      // The other half of regenerating the session. express-session gives the
      // browser a new session id here so that an id planted on it beforehand
      // cannot be used afterwards — but the CSRF secret lives in a cookie of
      // its own (see middlewares/csrf.ts), so it survived the login untouched.
      // Anyone who had fixed a secret onto the browser could therefore go on
      // minting tokens the now-privileged session accepts.
      //
      // Rotating it is not free, and this comment used to claim it was, on the
      // grounds that the redirect below renders no page. This response leaves
      // no stale token behind — but every other tab the browser had open
      // before the login still holds a page whose token masks the old secret,
      // and a form submitted from one of them is refused with the "expired"
      // 403 until that tab is reloaded. That is the accepted price. The one
      // form where it read as something worse is the logout, which answered
      // "your session has expired" while leaving the session signed in — so
      // validateCsrf lets a logout through on a same-origin Origin alone; see
      // isOwnLogout there.
      issueCsrfSecret(req, res);

      // This browser has now signed in to this account, which is what the
      // account-wide backstop lets it skip on a later attempt — see
      // utils/device-cookie.ts and accountLimiter above.
      issueDeviceCookie(res, accountKey(req));

      // Saved before the redirect, not by express-session on the way out.
      // Its res.end wrapper writes the status line and headers first and only
      // then waits for the store — and a browser follows a 302 the moment the
      // headers arrive. So the GET / after a login could reach the app before
      // the INSERT into "session" had committed, find no such session, and
      // render the page logged out: the admin logs in and is shown the
      // visitor's view. Waiting for the store closes that window.
      req.session.save((saveError) => {
        if (saveError) return next(saveError);

        res.redirect("/");
      });
    });
  },
);

// POST, not GET. Logging out changes state, and validateCsrf only guards the
// unsafe methods — so as a GET any other site could end an admin's session
// with an <img src="/logout">.
//
// A same-origin POST gets here even with a stale token or none — see
// isOwnLogout in middlewares/csrf.ts for why this one route is let through on
// its Origin alone.
router.post("/logout", async (req, res) => {
  // The row and the cookie; see endSession for why a failure to delete the
  // row is logged rather than turned into a 500, and why the row stays gone
  // even with another request of this session still in flight.
  await endSession(req, res);

  // And the secret the session's forms were signed against, for the same
  // reason the login rotates it: everything identifying this browser as
  // the one that was logged in should end here. csrfToken has already
  // re-sent the *existing* secret on this response, so this Set-Cookie has
  // to come after it — it does, middleware runs before the route — and it
  // is the later header for the same name, which is the one the browser
  // keeps.
  //
  // The device cookie is deliberately left alone. It says that this browser
  // has signed in to the account before, which a logout does not make any
  // less true, and it is exactly what the owner needs on hand the next time
  // they sign in if the account is under attack by then.
  issueCsrfSecret(req, res);

  res.redirect("/");
});

export default router;
