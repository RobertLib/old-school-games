import express from "express";
import isAuth from "../middlewares/is-auth.ts";
import isAdmin from "../middlewares/is-admin.ts";
import Game from "../models/game.ts";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { validateGame, validateGameRating } from "../validations/games.ts";
import { parseId } from "../utils/ids.ts";
import { isMissingGameError } from "../utils/pg-errors.ts";
import { loadSidebarData } from "../middlewares/sidebar-data.ts";
import {
  PostgresRateLimitStore,
  rateLimitLogger,
} from "../utils/rate-limit-store.ts";

const router = express.Router();

// Hydrates the favourites / recently-played lists the browser stores as bare
// ids, so titles, artwork and ratings are never stale.
router.get("/collection", async (req, res) => {
  const raw = typeof req.query.ids === "string" ? req.query.ids : "";
  const ids = raw.split(",").filter(Boolean).slice(0, 100);

  // No try/catch. Express 5 hands a rejected async handler to the error
  // handler by itself, and app.ts answers this endpoint in JSON with the
  // same 500 and the same body — expectsJson names it — after logging the
  // stack rather than the one line this used to log. The wrapper was a
  // second, thinner copy of the error handler that could only drift from it.
  const games = await Game.findByIds(ids);

  res.json({
    games: games.map((game) => ({
      id: game.id,
      title: game.title,
      slug: game.slug,
      genre: game.genre,
      release: game.release,
      developer: game.developer,
      // game.cover skips a blank first slot, which images[0] returned as ""
      // — and the client then rendered <img src="">, which a browser
      // resolves against the current document and fetches as an image.
      image: game.cover,
      // game.summary, so these cards and the server-rendered ones in
      // views/games/game-item.ejs derive their blurb the same way. This was
      // the correct version of a flatten the template did by hand, and the
      // two disagreed: the template stripped only the literal "<br />" and
      // showed the reader "<br>" and "&amp;" for everything else.
      description: game.summary,
      averageRating: game.averageRating ?? 0,
      ratingCount: game.ratingCount ?? 0,
    })),
  });
});

// Ratings this browser has already cast, so the stars can show them back.
router.get("/my-ratings", async (req, res) => {
  if (!req.voterId) {
    res.json({ ratings: {} });
    return;
  }

  // Unguarded, like /collection above: the app's own error handler answers
  // this one in JSON too.
  res.json({ ratings: await Game.getVoterRatings(req.voterId) });
});

/**
 * Kept out of the index, on every render of either admin form.
 *
 * robots.txt disallows /games/new and the edit form, and routes/sitemap.ts
 * sets out at length why a Disallow is the weaker of the two guarantees: a
 * blocked URL can still be indexed from an inbound link, precisely because
 * the tag forbidding it sits behind the block that stops it being read. The
 * same reasoning retired the Disallow lines for /login, /profile and the
 * search results; these four forms were the ones left relying on it alone.
 *
 * Nothing is expected to reach them — both routes are behind isAuth and
 * isAdmin, and views/index.ejs draws the link only for a signed-in admin — so
 * this is the reliable half of a pair rather than a fix for anything visible
 * in the index today.
 *
 * Spread into the render calls rather than written at each of them, because
 * each form is rendered twice: once by the GET below and again by its POST
 * handler when validation fails. Those two paths drifting apart is how a
 * 422 would come to answer without the tag its own GET carries.
 */
const ADMIN_FORM_META = { noindex: true };

router.get("/new", isAuth, isAdmin, async (req, res) => {
  res.render("games/new-game", { ...ADMIN_FORM_META, game: null });
});

/**
 * The live genre enum, for validating what the form posted. Taken from the
 * sidebar's cached copy when there is one — the same shortcut the genre
 * route uses — so the common path costs no query.
 *
 * Emptiness, not `??`. sidebarData sets this local on every request that
 * renders a page, and when its own query fails it sets the entry's fallback —
 * which for `gameGenres` is `[]`, not `undefined`. Neither form is nullish, so
 * `??` never reached the query behind it: an admin saving the form during a
 * database blip was handed an empty allowlist and told their genre was
 * unknown, which is the one thing this list exists to decide correctly. The
 * fallback query is the point of the expression, so the test for it is the one
 * that lets it run.
 */
async function genreList(res: express.Response): Promise<string[]> {
  const cached = res.locals.gameGenres as string[] | undefined;

  return cached?.length ? cached : await Game.getGenres();
}

// No try/catch: express 5 hands a rejected async handler to the error
// handler by itself, and this one did nothing but pass the error along. The
// same goes for every route below.
router.post("/", isAuth, isAdmin, async (req, res) => {
  const errors = validateGame(req.body, await genreList(res));

  // Back to the form with the admin's own values, rather than the 500 page
  // a missing genre or an over-long title used to produce — which threw the
  // whole entry away.
  //
  // 422, not the 200 this used to answer with. A form that came back
  // covered in errors did not succeed, and a 200 says it did: it is what a
  // browser and a password manager read as "that worked", it is what an
  // access log shows as a successful write, and it is what anything
  // retrying on failure — a script, a monitor — takes as no reason to
  // retry. routes/auth.ts already made this distinction for the login form
  // and wrote down why; the admin forms were the ones left over.
  //
  // 422 rather than the 400 that route uses, because the two are refusing
  // different things: a 400 there is a body that could not be read at all
  // (a missing or non-string field), where everything here parsed fine and
  // it is the *content* that validateGame rejected.
  if (errors.length > 0) {
    // The chrome, which needsSidebarData skipped on the way in: every other
    // outcome of this route is a redirect, so the six queries behind it are
    // loaded here, on the one path that renders.
    await loadSidebarData(res);

    return res.status(422).render("games/new-game", {
      ...ADMIN_FORM_META,
      game: null,
      errors,
      formData: req.body,
    });
  }

  await Game.create(req.body);

  req.flash("success", "Game created successfully.");

  res.redirect("/");
});

router.get("/:id/edit", isAuth, isAdmin, async (req, res, next) => {
  const id = parseId(req.params.id);

  if (id === null) {
    return next();
  }

  const game = await Game.findById(id);

  if (!game) {
    return next();
  }

  res.render("games/edit-game", { ...ADMIN_FORM_META, game });
});

router.post("/:id", isAuth, isAdmin, async (req, res, next) => {
  const id = parseId(req.params.id);

  if (id === null) {
    return next();
  }

  const errors = validateGame(req.body, await genreList(res));

  if (errors.length > 0) {
    const existing = await Game.findById(id);

    if (!existing) {
      return next();
    }

    // The chrome, for the reason given on the create route above.
    await loadSidebarData(res);

    // 422, for the reason spelled out on the create route above.
    return res.status(422).render("games/edit-game", {
      ...ADMIN_FORM_META,
      game: existing,
      errors,
      formData: req.body,
    });
  }

  const game = await Game.update(id, req.body);

  // next(), like every other missing-game exit in this router, so the app's
  // own 404 view answers rather than the line of plain text this used to
  // send. It is reachable by an admin submitting the edit form for a game
  // that has been deleted since the page was opened, and the /:id/edit
  // route directly above already answers that case this way.
  if (!game) {
    return next();
  }

  req.flash("success", "Game updated successfully.");

  res.redirect("/");
});

router.post("/:id/delete", isAuth, isAdmin, async (req, res, next) => {
  const id = parseId(req.params.id);

  if (id === null) {
    return next();
  }

  const deleted = await Game.delete(id);

  // Flash and redirect rather than next() — the same choice the comment
  // moderation route makes, and for the same reason: this is a form post from
  // an admin looking at a page that has gone stale, not a visitor typing an
  // address, so it belongs back on the page it came from with an explanation.
  if (!deleted) {
    req.flash("error", "Game not found.");
    res.redirect("/");
    return;
  }

  req.flash("success", "Game deleted successfully.");

  res.redirect("/");
});

/**
 * How long the two per-game budgets below last: a day, so "a handful" means a
 * handful a day rather than a handful a minute.
 *
 * The address-wide limiters on these two endpoints are flood brakes, sized so
 * that a school or an office behind one NAT is not locked out, and nothing
 * stopped one client spending the whole of either on a single game. Thirty
 * plays a minute is ~43,000 a day on one game — enough to own /most-played and
 * the sidebar's "Most played" outright — and fifty votes a quarter hour,
 * deduplicated only by a voter cookie the client can simply not send back, is
 * ~4,800 votes a day on one game, which buries the five votes of doubt the
 * ranking weighs every game with (see WEIGHTED_RATING in models/game.ts).
 *
 * Counted in the shared Postgres store like every other limiter, so a budget
 * is the site's and not one machine's.
 *
 * The key holds the caller's address for this long — up to the window plus
 * the ten-minute sweep in utils/rate-limit-store.ts — which is what the
 * rate-limiting paragraph of views/privacy-policy.ejs says, and the suite
 * holds the two together. Exported for that.
 */
export const PER_GAME_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Plays of one game counted from one address in a day.
 *
 * A play is a click on the poster, and one person playing a game on a given
 * day starts it once, or a few times — a reload, a crash, coming back to it
 * after lunch. Five covers that. The sixth start from the same address is not
 * a sixth player, and it is not counted. A classroom behind one address all
 * starting the same game counts as five, which under-counts it; that is the
 * price of a ranking one address cannot buy, and nobody in the classroom sees
 * it — public/js/game-player.js fires the play and ignores the answer, and the
 * game has already started by then.
 */
export const PLAYS_PER_GAME = 5;

/**
 * Votes on one game accepted from one address in a day — new ones and
 * changed ones alike, because the request cannot tell the two apart without
 * trusting the cookie, which is the part a script leaves out.
 *
 * One person rates a game once and may change their mind a time or two; a
 * couple of people behind one router may each rate the same game. Five covers
 * both. A client dropping its cookie between votes gets five a day on that
 * game instead of ~4,800 — still something, and every one of them carries the
 * address it came from for the ninety days ratings keep one, which is what
 * investigating it needs. A refusal is shown to the visitor: rating-stars.js
 * alerts the `error` in the JSON body, which is why it is written to be read.
 */
export const RATINGS_PER_GAME = 5;

/**
 * The key both per-game budgets count under: the caller's address and the
 * game.
 *
 * ipKeyGenerator, because an IPv6 client is handed a whole range and keying
 * on the exact address would give it a fresh budget per address it cares to
 * source from. It collapses one to its /56 and leaves IPv4 alone — the
 * library's default, which is also how the address-wide limiters above and
 * below group a caller, since they keep the default key. Not the /48 the
 * login limiters use (see clientKey in routes/auth.ts): their reason is that
 * only administrators post there, and these budgets are every visitor's. A
 * residential provider routinely hands each household its own /56, so a /48
 * can be a couple of hundred homes sharing five plays of a game a day.
 *
 * The id through parseId, so the key is the number the row is stored under —
 * the validators in front of both limiters have already refused anything
 * that is not one.
 */
function addressAndGame(req: express.Request): string {
  return `${ipKeyGenerator(req.ip ?? "")}:${parseId(req.params.id)}`;
}

const ratingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  // An object, not a string: express-rate-limit sends a string with
  // res.send(), and rating-stars.js reads the reason off `error` in a JSON
  // body — so a throttled visitor was told "Failed to submit rating" rather
  // than that they had simply rated too much.
  message: { error: "Too many ratings from this IP, please try again later." },
  store: new PostgresRateLimitStore("rate"),
  passOnStoreError: true,
  // ...and says so through utils/logger.ts rather than the library's
  // own console fallback — see rateLimitLogger.
  logger: rateLimitLogger,
});

/**
 * RATINGS_PER_GAME, per address per game per day — see PER_GAME_WINDOW_MS.
 *
 * Behind ratingLimiter rather than in front of it, so a flood the address
 * brake has already refused is not also charged to this game's budget. Its
 * own prefix, so the two counts never share a key; express-rate-limit also
 * reads the prefix to tell two limiters legitimately counting one request
 * from a double count.
 */
const ratingPerGameLimiter = rateLimit({
  windowMs: PER_GAME_WINDOW_MS,
  limit: RATINGS_PER_GAME,
  keyGenerator: addressAndGame,
  message: {
    error:
      "You have rated this game too many times today. Please try again tomorrow.",
  },
  store: new PostgresRateLimitStore("rate-game"),
  passOnStoreError: true,
  logger: rateLimitLogger,
});

/**
 * A request with no voter id, refused before the limiter counts it.
 *
 * This check used to live inside the handler, which put it *after*
 * ratingLimiter — so a browser that refuses cookies, or a script that never
 * sends one, spent one of the fifty ratings per quarter hour on every attempt
 * and could never have any of them stored. Fifty of those and the address was
 * out of budget, taking every real voter behind the same NAT with it. Exactly
 * the reason requireGameId sits ahead of the play limiter below: a request
 * that cannot possibly be stored must not be charged for.
 */
function requireVoterId(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!req.voterId) {
    res.status(400).json({ error: "Cookies are required to rate games" });
    return;
  }

  next();
}

// validateGameRating and requireVoterId ahead of both limiters, for the same
// reason requireGameId sits ahead of the play limiters below: refusing a
// malformed id, a rating that is not 1-5, or a caller with no voter cookie
// costs a regex and no database access, so a broken client looping on it
// should not spend the budgets that real votes come out of. The per-game key
// also reads the id, which only the validator has checked is one.
router.post(
  "/:id/rate",
  validateGameRating,
  requireVoterId,
  ratingLimiter,
  ratingPerGameLimiter,
  async (req, res) => {
    // validateGameRating has already rejected anything that is not a plain
    // positive integer. Passing req.params.id on raw let "5abc" through: the
    // lenient parseInt in the validator read it as 5, then the untouched
    // string reached Postgres and came back a 500.
    const id = parseId(req.params.id)!;
    const { rating } = req.body;
    const { ip } = req;
    // Non-null because requireVoterId above answered 400 for anything without
    // one; the type stays optional because every other route sees a request
    // that may genuinely have none.
    const voterId = req.voterId!;

    // The catch is kept, but only for the one case it can answer better than
    // the error handler: a game deleted while its page was open is a 404,
    // not a fault. Anything else is rethrown, so app.ts logs the stack and
    // answers the JSON 500 this used to write out by hand.
    try {
      await Game.rate(id, voterId, rating, ip);

      const summary = await Game.getRatingSummary(id);

      res.status(200).send({ ...summary, userRating: rating });
    } catch (error) {
      if (isMissingGameError(error)) {
        res.status(404).json({ error: "Game not found" });
        return;
      }

      throw error;
    }
  },
);

// One request per game started. Five a minute counted a classroom or an
// office behind a single NAT as an attack — a handful of people picking games
// exhausts it in seconds. This is still far below what a runaway loop does,
// and a malformed id never reaches the counter at all (see below).
const playLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  // JSON, like every other answer this endpoint gives — see expects-json.ts.
  message: { error: "Too many play requests, please try again later." },
  store: new PostgresRateLimitStore("play"),
  passOnStoreError: true,
  // ...and says so through utils/logger.ts rather than the library's
  // own console fallback — see rateLimitLogger.
  logger: rateLimitLogger,
});

/**
 * PLAYS_PER_GAME, per address per game per day — see PER_GAME_WINDOW_MS.
 * Behind playLimiter for the reason ratingPerGameLimiter sits behind its own.
 *
 * The 429 is harmless to the page that sent it: game-player.js posts the play
 * without awaiting it and drops whatever comes back, and the emulator frame is
 * already on its way in. A refused play is simply one the ranking does not
 * count.
 */
const playPerGameLimiter = rateLimit({
  windowMs: PER_GAME_WINDOW_MS,
  limit: PLAYS_PER_GAME,
  keyGenerator: addressAndGame,
  message: {
    error: "Plays of this game from your address have been counted for today.",
  },
  store: new PostgresRateLimitStore("play-game"),
  passOnStoreError: true,
  logger: rateLimitLogger,
});

// Ahead of both limiters: rejecting a malformed id costs a regex and no
// database access, and the play budget is small enough that a broken link
// hammering /games/abc/play would otherwise lock real plays out for everyone
// behind the same address. The per-game key is built from the id this checks.
function requireGameId(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (parseId(req.params.id) === null) {
    res.status(400).json({ error: "Invalid game ID" });
    return;
  }

  next();
}

router.post(
  "/:id/play",
  requireGameId,
  playLimiter,
  playPerGameLimiter,
  async (req, res) => {
    const id = parseId(req.params.id)!;

    // Narrowed to the 404, like the rating route above.
    try {
      await Game.recordPlay(id);
      res.status(204).send();
    } catch (error) {
      if (isMissingGameError(error)) {
        res.status(404).json({ error: "Game not found" });
        return;
      }

      throw error;
    }
  },
);

export default router;
